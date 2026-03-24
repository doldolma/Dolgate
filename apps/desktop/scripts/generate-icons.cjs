const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const desktopDir = path.resolve(__dirname, '..');
const sourceSvg = path.join(desktopDir, 'assets', 'icons', 'dolssh-icon.svg');
const buildDir = path.join(desktopDir, 'build', 'icons');
const pngDir = path.join(buildDir, 'png');
const iconsetDir = path.join(buildDir, 'dolssh.iconset');
const requiredOutputs = ['dolssh.icns', 'dolssh.ico', 'dolssh.png'].map((fileName) => path.join(buildDir, fileName));

const pngSizes = [16, 32, 48, 64, 128, 256, 512, 1024];

function hasCommand(command) {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function resetDirectory(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(targetPath, { recursive: true });
}

function renderPng(size) {
  const outputPath = path.join(pngDir, `dolssh-${size}.png`);
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', outputPath, sourceSvg], { stdio: 'inherit' });
  return outputPath;
}

function writeIconset(pngMap) {
  resetDirectory(iconsetDir);
  const entries = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ];

  for (const [fileName, size] of entries) {
    fs.copyFileSync(pngMap.get(size), path.join(iconsetDir, fileName));
  }
}

function buildIcns() {
  const icnsPath = path.join(buildDir, 'dolssh.icns');
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath], { stdio: 'inherit' });
  return icnsPath;
}

function buildIco(pngMap) {
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const images = icoSizes.map((size) => ({
    size,
    data: fs.readFileSync(pngMap.get(size))
  }));

  const headerSize = 6 + images.length * 16;
  let offset = headerSize;
  const buffers = [];
  const header = Buffer.alloc(headerSize);

  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  images.forEach((image, index) => {
    const entryOffset = 6 + index * 16;
    header.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset);
    header.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(image.data.length, entryOffset + 8);
    header.writeUInt32LE(offset, entryOffset + 12);
    buffers.push(image.data);
    offset += image.data.length;
  });

  const icoPath = path.join(buildDir, 'dolssh.ico');
  fs.writeFileSync(icoPath, Buffer.concat([header, ...buffers]));
  return icoPath;
}

function hasGeneratedIcons() {
  return requiredOutputs.every((outputPath) => fs.existsSync(outputPath));
}

function main() {
  const hasRsvgConvert = hasCommand('rsvg-convert');
  const hasIconutil = hasCommand('iconutil');
  const canGenerateIcons = hasRsvgConvert && hasIconutil;

  if (!canGenerateIcons) {
    if (hasGeneratedIcons()) {
      console.log('아이콘 생성 도구가 없어 기존 아이콘 산출물을 재사용합니다.');
      return;
    }

    const missingCommands = [
      ...(hasRsvgConvert ? [] : ['rsvg-convert']),
      ...(hasIconutil ? [] : ['iconutil'])
    ];
    throw new Error(`${missingCommands.join(', ')} 명령을 찾을 수 없습니다. 기존 아이콘 산출물이 없어서 빌드를 계속할 수 없습니다.`);
  }

  resetDirectory(buildDir);
  fs.mkdirSync(pngDir, { recursive: true });

  const pngMap = new Map();
  for (const size of pngSizes) {
    pngMap.set(size, renderPng(size));
  }

  writeIconset(pngMap);
  const icnsPath = buildIcns();
  const icoPath = buildIco(pngMap);
  const pngPath = path.join(buildDir, 'dolssh.png');
  fs.copyFileSync(pngMap.get(1024), pngPath);

  console.log(`아이콘 생성 완료:\n- ${icnsPath}\n- ${icoPath}\n- ${pngPath}`);
}

main();
