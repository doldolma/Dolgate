const QWERTY_TO_JAMO: Record<string, string> = {
  r: 'ㄱ',
  R: 'ㄲ',
  s: 'ㄴ',
  e: 'ㄷ',
  E: 'ㄸ',
  f: 'ㄹ',
  a: 'ㅁ',
  q: 'ㅂ',
  Q: 'ㅃ',
  t: 'ㅅ',
  T: 'ㅆ',
  d: 'ㅇ',
  w: 'ㅈ',
  W: 'ㅉ',
  c: 'ㅊ',
  z: 'ㅋ',
  x: 'ㅌ',
  v: 'ㅍ',
  g: 'ㅎ',
  k: 'ㅏ',
  o: 'ㅐ',
  i: 'ㅑ',
  O: 'ㅒ',
  j: 'ㅓ',
  p: 'ㅔ',
  u: 'ㅕ',
  P: 'ㅖ',
  h: 'ㅗ',
  y: 'ㅛ',
  n: 'ㅜ',
  b: 'ㅠ',
  m: 'ㅡ',
  l: 'ㅣ',
};

const JAMO_TO_QWERTY: Record<string, string> = {
  ㄱ: 'r',
  ㄲ: 'R',
  ㄳ: 'rt',
  ㄴ: 's',
  ㄵ: 'sw',
  ㄶ: 'sg',
  ㄷ: 'e',
  ㄸ: 'E',
  ㄹ: 'f',
  ㄺ: 'fr',
  ㄻ: 'fa',
  ㄼ: 'fq',
  ㄽ: 'ft',
  ㄾ: 'fx',
  ㄿ: 'fv',
  ㅀ: 'fg',
  ㅁ: 'a',
  ㅂ: 'q',
  ㅃ: 'Q',
  ㅄ: 'qt',
  ㅅ: 't',
  ㅆ: 'T',
  ㅇ: 'd',
  ㅈ: 'w',
  ㅉ: 'W',
  ㅊ: 'c',
  ㅋ: 'z',
  ㅌ: 'x',
  ㅍ: 'v',
  ㅎ: 'g',
  ㅏ: 'k',
  ㅐ: 'o',
  ㅑ: 'i',
  ㅒ: 'O',
  ㅓ: 'j',
  ㅔ: 'p',
  ㅕ: 'u',
  ㅖ: 'P',
  ㅗ: 'h',
  ㅘ: 'hk',
  ㅙ: 'ho',
  ㅚ: 'hl',
  ㅛ: 'y',
  ㅜ: 'n',
  ㅝ: 'nj',
  ㅞ: 'np',
  ㅟ: 'nl',
  ㅠ: 'b',
  ㅡ: 'm',
  ㅢ: 'ml',
  ㅣ: 'l',
};

const INITIALS = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const VOWELS = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
const FINALS = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

const INITIAL_SET = new Set(INITIALS);
const VOWEL_SET = new Set(VOWELS);
const FINAL_SET = new Set(FINALS.filter(Boolean));

const COMPOUND_VOWELS: Record<string, string> = {
  ㅗㅏ: 'ㅘ',
  ㅗㅐ: 'ㅙ',
  ㅗㅣ: 'ㅚ',
  ㅜㅓ: 'ㅝ',
  ㅜㅔ: 'ㅞ',
  ㅜㅣ: 'ㅟ',
  ㅡㅣ: 'ㅢ',
};

const COMPOUND_FINALS: Record<string, string> = {
  ㄱㅅ: 'ㄳ',
  ㄴㅈ: 'ㄵ',
  ㄴㅎ: 'ㄶ',
  ㄹㄱ: 'ㄺ',
  ㄹㅁ: 'ㄻ',
  ㄹㅂ: 'ㄼ',
  ㄹㅅ: 'ㄽ',
  ㄹㅌ: 'ㄾ',
  ㄹㅍ: 'ㄿ',
  ㄹㅎ: 'ㅀ',
  ㅂㅅ: 'ㅄ',
};

function qwertyKeyToJamo(character: string): string | null {
  return QWERTY_TO_JAMO[character] ?? QWERTY_TO_JAMO[character.toLowerCase()] ?? null;
}

function readVowel(jamo: string[], index: number): { vowel: string; nextIndex: number } {
  const current = jamo[index];
  const next = jamo[index + 1];
  const compound = current && next ? COMPOUND_VOWELS[`${current}${next}`] : null;
  if (compound) {
    return { vowel: compound, nextIndex: index + 2 };
  }
  return { vowel: current, nextIndex: index + 1 };
}

function composeHangulSyllable(initial: string, vowel: string, final = ''): string {
  const initialIndex = INITIALS.indexOf(initial);
  const vowelIndex = VOWELS.indexOf(vowel);
  const finalIndex = FINALS.indexOf(final);

  if (initialIndex < 0 || vowelIndex < 0 || finalIndex < 0) {
    return `${initial}${vowel}${final}`;
  }

  return String.fromCharCode(0xac00 + (initialIndex * VOWELS.length + vowelIndex) * FINALS.length + finalIndex);
}

function composeJamoRun(jamo: string[]): string {
  let output = '';
  let index = 0;

  while (index < jamo.length) {
    const current = jamo[index];

    if (VOWEL_SET.has(current)) {
      const vowel = readVowel(jamo, index);
      output += composeHangulSyllable('ㅇ', vowel.vowel);
      index = vowel.nextIndex;
      continue;
    }

    if (!INITIAL_SET.has(current) || !VOWEL_SET.has(jamo[index + 1])) {
      output += current;
      index += 1;
      continue;
    }

    const initial = current;
    const vowel = readVowel(jamo, index + 1);
    let nextIndex = vowel.nextIndex;
    let final = '';
    const finalCandidate = jamo[nextIndex];

    if (FINAL_SET.has(finalCandidate) && !VOWEL_SET.has(jamo[nextIndex + 1])) {
      const compoundCandidate = COMPOUND_FINALS[`${finalCandidate}${jamo[nextIndex + 1]}`];
      if (compoundCandidate && !VOWEL_SET.has(jamo[nextIndex + 2])) {
        final = compoundCandidate;
        nextIndex += 2;
      } else {
        final = finalCandidate;
        nextIndex += 1;
      }
    }

    output += composeHangulSyllable(initial, vowel.vowel, final);
    index = nextIndex;
  }

  return output;
}

export function convertQwertyToDubeolsikHangul(input: string): string {
  let output = '';
  let jamoRun: string[] = [];

  for (const character of input) {
    const jamo = qwertyKeyToJamo(character);
    if (jamo) {
      jamoRun.push(jamo);
      continue;
    }

    if (jamoRun.length > 0) {
      output += composeJamoRun(jamoRun);
      jamoRun = [];
    }
    output += character;
  }

  if (jamoRun.length > 0) {
    output += composeJamoRun(jamoRun);
  }

  return output;
}

export function convertHangulToQwerty(input: string): string {
  let output = '';

  for (const character of input) {
    const codePoint = character.charCodeAt(0);
    if (codePoint >= 0xac00 && codePoint <= 0xd7a3) {
      const syllableIndex = codePoint - 0xac00;
      const finalIndex = syllableIndex % FINALS.length;
      const vowelIndex = Math.floor(syllableIndex / FINALS.length) % VOWELS.length;
      const initialIndex = Math.floor(syllableIndex / FINALS.length / VOWELS.length);
      output += `${JAMO_TO_QWERTY[INITIALS[initialIndex]] ?? ''}${JAMO_TO_QWERTY[VOWELS[vowelIndex]] ?? ''}${JAMO_TO_QWERTY[FINALS[finalIndex]] ?? ''}`;
      continue;
    }

    output += JAMO_TO_QWERTY[character] ?? character;
  }

  return output;
}

export function getKeyboardLayoutSearchQueries(query: string): string[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  return Array.from(
    new Set([
      trimmedQuery,
      convertHangulToQwerty(trimmedQuery),
      convertQwertyToDubeolsikHangul(trimmedQuery),
    ].filter(Boolean)),
  );
}

export function matchesKeyboardLayoutQuery(text: string, query: string): boolean {
  const normalizedText = text.toLocaleLowerCase();
  return getKeyboardLayoutSearchQueries(query).some((variant) =>
    normalizedText.includes(variant.toLocaleLowerCase()),
  );
}
