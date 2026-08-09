import type { RegionBlit } from "./canvas-region";

/**
 * 원격 화면을 그리는 표면.
 *
 * 두 가지 구현이 있다. WebGL2 는 누적본을 GPU 텍스처로 들고 dirty rect 를 거기 직접 올린다.
 * Canvas2D 는 오프스크린 캔버스에 putImageData 로 쌓고 다시 drawImage 로 옮긴다 — 픽셀을 두 번
 * 만지고, putImageData 는 매번 캔버스 텍스처를 무효화해 GPU 재업로드를 부른다.
 */
export interface FrameSurface {
  /** 원격 데스크톱 크기가 정해지거나 바뀌었다. 누적본은 여기서 새로 만들어진다(=비워진다). */
  resize(desktopWidth: number, desktopHeight: number): void;
  /** dirty rect 를 누적본에 올린다. 화면에 그리지는 않는다. */
  store(x: number, y: number, width: number, height: number, pixels: Uint8Array): void;
  /** 누적본의 바뀐 조각을 보이는 화면으로 옮긴다. */
  present(blit: RegionBlit): void;
  /** 보이는 화면 전체를 누적본에서 다시 칠한다. 크기 변경·탭 복귀 뒤에 쓴다. */
  repaint(sourceX: number, sourceY: number, width: number, height: number): void;
  dispose(): void;
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv);
}`;

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) {
    return null;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createWebglSurface(
  canvas: HTMLCanvasElement,
  gl: WebGL2RenderingContext,
): FrameSurface | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = vertex && fragment ? gl.createProgram() : null;
  if (!vertex || !fragment || !program) {
    return null;
  }

  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return null;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  const vao = gl.createVertexArray();
  const texture = gl.createTexture();
  if (!buffer || !vao || !texture) {
    return null;
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // 사각형 하나(triangle strip 4점). 정점마다 위치 2 + UV 2 = 4 float.
  gl.bufferData(gl.ARRAY_BUFFER, 16 * 4, gl.DYNAMIC_DRAW);

  const posLocation = gl.getAttribLocation(program, "a_pos");
  const uvLocation = gl.getAttribLocation(program, "a_uv");
  gl.enableVertexAttribArray(posLocation);
  gl.vertexAttribPointer(posLocation, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(uvLocation);
  gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 16, 8);

  gl.bindTexture(gl.TEXTURE_2D, texture);
  // 원격 화면은 밉맵도 반복도 쓰지 않는다. LINEAR + CLAMP 가 축소 표시에 맞다.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // 행 정렬 기본값은 4바이트다. RGBA 는 픽셀당 4바이트라 맞지만, 폭이 홀수인 rect 를 올릴 때
  // 어긋나지 않도록 1로 낮춘다.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  let textureWidth = 0;
  let textureHeight = 0;
  const vertices = new Float32Array(16);

  // 화면에 그릴 영역(누적 텍스처 안의 사각형). 크기나 담당 영역이 정해질 때 갱신된다.
  let view: { x: number; y: number; width: number; height: number } | null = null;

  const draw = (
    sourceX: number,
    sourceY: number,
    width: number,
    height: number,
    destX: number,
    destY: number,
  ) => {
    if (textureWidth === 0 || textureHeight === 0) {
      return;
    }

    // 캔버스 픽셀 → 클립 공간. 캔버스는 y 가 아래로, 클립은 위로 자라므로 y 를 뒤집는다.
    const x0 = (destX / canvas.width) * 2 - 1;
    const x1 = ((destX + width) / canvas.width) * 2 - 1;
    const y0 = 1 - (destY / canvas.height) * 2;
    const y1 = 1 - ((destY + height) / canvas.height) * 2;

    // 텍스처는 첫 픽셀이 v=0 이고, 우리는 첫 픽셀이 화면 위쪽이길 원한다 — 그래서 위쪽 정점에
    // 작은 v 를 준다(뒤집지 않는다).
    const u0 = sourceX / textureWidth;
    const u1 = (sourceX + width) / textureWidth;
    const v0 = sourceY / textureHeight;
    const v1 = (sourceY + height) / textureHeight;

    vertices.set([
      x0, y0, u0, v0,
      x1, y0, u1, v0,
      x0, y1, u0, v1,
      x1, y1, u1, v1,
    ]);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  return {
    resize(desktopWidth, desktopHeight) {
      textureWidth = desktopWidth;
      textureHeight = desktopHeight;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // 누적본은 이 텍스처 자체다. 크기가 바뀌면 새로 만들어지고 내용은 사라진다 — 서버가
      // 정적인 영역을 다시 보내주지 않으므로, 크기 변경은 아껴야 한다.
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        desktopWidth,
        desktopHeight,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
    },

    store(x, y, width, height, pixels) {
      if (textureWidth === 0) {
        return;
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // rdp-core 가 stride 를 이미 걷어내고 촘촘히 담아 보내므로 그대로 올린다.
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        x,
        y,
        width,
        height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
    },

    present(blit) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      draw(
        blit.sourceX,
        blit.sourceY,
        blit.width,
        blit.height,
        blit.destX,
        blit.destY,
      );
    },

    repaint(sourceX, sourceY, width, height) {
      view = { x: sourceX, y: sourceY, width, height };
      gl.viewport(0, 0, canvas.width, canvas.height);
      draw(sourceX, sourceY, width, height, 0, 0);
    },

    dispose() {
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    },
  };
}

function createCanvas2dSurface(canvas: HTMLCanvasElement): FrameSurface | null {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    return null;
  }

  let buffer: HTMLCanvasElement | null = null;
  let bufferContext: CanvasRenderingContext2D | null = null;
  // 화면에 그릴 영역(누적본 안의 사각형).
  let view: { x: number; y: number; width: number; height: number } | null = null;

  return {
    resize(desktopWidth, desktopHeight) {
      const next = document.createElement("canvas");
      next.width = desktopWidth;
      next.height = desktopHeight;
      buffer = next;
      bufferContext = next.getContext("2d", { alpha: false });
    },

    store(x, y, width, height, pixels) {
      if (!bufferContext) {
        return;
      }
      // IPC 로 넘어온 Uint8Array 는 항상 ArrayBuffer 기반이지만 타입상으로는 SharedArrayBuffer 도
      // 가능해 ImageData 가 거부한다. 사본을 뜨지 않으려면 여기서 좁혀 주는 수밖에 없다.
      const image = new ImageData(
        new Uint8ClampedArray(
          pixels.buffer as ArrayBuffer,
          pixels.byteOffset,
          width * height * 4,
        ),
        width,
        height,
      );
      bufferContext.putImageData(image, x, y);
    },

    present(blit) {
      if (!buffer) {
        return;
      }
      context.drawImage(
        buffer,
        blit.sourceX,
        blit.sourceY,
        blit.width,
        blit.height,
        blit.destX,
        blit.destY,
        blit.width,
        blit.height,
      );
    },

    repaint(sourceX, sourceY, width, height) {
      view = { x: sourceX, y: sourceY, width, height };
      if (!buffer) {
        return;
      }
      context.drawImage(
        buffer,
        sourceX,
        sourceY,
        width,
        height,
        0,
        0,
        width,
        height,
      );
    },

    dispose() {
      buffer = null;
      bufferContext = null;
    },
  };
}

/** 이 캔버스에 쓸 표면을 만든다. */
export function createFrameSurface(canvas: HTMLCanvasElement): FrameSurface | null {
  // 지금은 Canvas2D 만 쓴다.
  //
  // WebGL2 로 바꾼 뒤 스크롤이 띄엄띄엄 차오르는 회귀가 생겼는데, 전환·드로잉 버퍼·그리기 시점을
  // 한꺼번에 바꿔서 어느 조각이 원인인지 좁히지 못했다. 회귀가 없던 경로로 돌려놓고, 원인이
  // 특정되면 한 조각씩 다시 얹는다.
  return createCanvas2dSurface(canvas);
}
