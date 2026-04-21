const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const desktopDir = path.resolve(__dirname, '..');
const mobileDir = path.resolve(desktopDir, '..', 'mobile');
const sourceSvg = path.join(desktopDir, 'assets', 'icons', 'dolssh-icon.svg');
const buildDir = path.join(desktopDir, 'build', 'icons');
const pngDir = path.join(buildDir, 'png');
const iconsetDir = path.join(buildDir, 'dolssh.iconset');
const iosAppIconDir = path.join(
  mobileDir,
  'ios',
  'Dolgate',
  'Images.xcassets',
  'AppIcon.appiconset',
);
const androidMipmapDir = path.join(mobileDir, 'android', 'app', 'src', 'main', 'res');
const requiredOutputs = ['dolssh.icns', 'dolssh.ico', 'dolssh.png'].map((fileName) => path.join(buildDir, fileName));

const iosAppIcons = [
  { fileName: 'icon-20@2x.png', size: 40 },
  { fileName: 'icon-20@3x.png', size: 60 },
  { fileName: 'icon-29@2x.png', size: 58 },
  { fileName: 'icon-29@3x.png', size: 87 },
  { fileName: 'icon-40@2x.png', size: 80 },
  { fileName: 'icon-40@3x.png', size: 120 },
  { fileName: 'icon-60@2x.png', size: 120 },
  { fileName: 'icon-60@3x.png', size: 180 },
  { fileName: 'icon-1024.png', size: 1024}
];

const androidLauncherIcons = [
  { directory: 'mipmap-mdpi', size: 48 },
  { directory: 'mipmap-hdpi', size: 72 },
  { directory: 'mipmap-xhdpi', size: 96 },
  { directory: 'mipmap-xxhdpi', size: 144 },
  { directory: 'mipmap-xxxhdpi', size: 192 }
];

const pngSizes = Array.from(
  new Set([
    16,
    32,
    40,
    48,
    58,
    60,
    64,
    72,
    80,
    87,
    96,
    120,
    128,
    144,
    180,
    192,
    256,
    512,
    1024
  ]),
).sort((left, right) => left - right);

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

function ensureParentDirectory(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function copySizedPng(pngMap, size, outputPath) {
  ensureParentDirectory(outputPath);
  fs.copyFileSync(pngMap.get(size), outputPath);
}

function renderInsetPng(sourcePath, outputPath, size, insetRatio = 0.08) {
  ensureParentDirectory(outputPath);
  const canvasSize = 1024;
  const inset = Math.round(canvasSize * insetRatio);
  const innerSize = canvasSize - inset * 2;
  const dataUri = `data:image/png;base64,${fs.readFileSync(sourcePath).toString('base64')}`;
  const tempSvgPath = path.join(
    os.tmpdir(),
    `dolssh-mobile-round-${size}-${process.pid}-${Date.now()}.svg`,
  );
  const wrapperSvg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">',
    `  <image href="${dataUri}" x="${inset}" y="${inset}" width="${innerSize}" height="${innerSize}" />`,
    '</svg>'
  ].join('\n');

  fs.writeFileSync(tempSvgPath, wrapperSvg);
  try {
    execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', outputPath, tempSvgPath], {
      stdio: 'inherit'
    });
  } finally {
    fs.rmSync(tempSvgPath, { force: true });
  }
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

function writeIosIcons(pngMap) {
  fs.mkdirSync(iosAppIconDir, { recursive: true });
  for (const icon of iosAppIcons) {
    copySizedPng(pngMap, icon.size, path.join(iosAppIconDir, icon.fileName));
  }
}

function writeAndroidIcons(pngMap) {
  const source1024 = pngMap.get(1024);
  for (const icon of androidLauncherIcons) {
    const squarePath = path.join(androidMipmapDir, icon.directory, 'ic_launcher.png');
    const roundPath = path.join(androidMipmapDir, icon.directory, 'ic_launcher_round.png');
    copySizedPng(pngMap, icon.size, squarePath);
    renderInsetPng(source1024, roundPath, icon.size);
  }
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
  writeIosIcons(pngMap);
  writeAndroidIcons(pngMap);

  console.log(
    `아이콘 생성 완료:\n- ${icnsPath}\n- ${icoPath}\n- ${pngPath}\n- ${iosAppIconDir}\n- ${path.join(
      androidMipmapDir,
      'mipmap-*/ic_launcher*.png',
    )}`,
  );
}

main();
