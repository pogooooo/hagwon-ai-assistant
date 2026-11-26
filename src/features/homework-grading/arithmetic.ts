import { GradingError } from './contracts.ts';

export const SCALE = 10000n;
export function points(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,14})(\.[0-9]{1,4})?$/.test(value))
    throw new GradingError('INVALID_SCORE');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'));
}
export function decimalString(value: bigint) {
  if (value < 0n) throw new GradingError('INVALID_SCORE');
  const fraction = (value % SCALE)
    .toString()
    .padStart(4, '0')
    .replace(/0+$/, '');
  return (value / SCALE).toString() + (fraction ? '.' + fraction : '');
}
/** A derived six-place ratio; keep the original numerator and denominator too. */
export function rate(numerator: bigint, denominator: bigint): string | null {
  if (!denominator) return null;
  const rounded =
    (numerator * 1000000n * 2n + denominator) / (2n * denominator);
  return `${rounded / 1000000n}.${(rounded % 1000000n).toString().padStart(6, '0')}`;
}
function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}
export function rational(n: bigint, d = 1n) {
  if (!d || n.toString().length > 120 || d.toString().length > 120)
    throw new GradingError('UNSUPPORTED_EXPRESSION');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
export type Rational = ReturnType<typeof rational>;
export function add(a: Rational, b: Rational) {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}
export function multiply(a: Rational, b: Rational) {
  return rational(a.n * b.n, a.d * b.d);
}
export function same(a: Rational, b: Rational) {
  return a.n === b.n && a.d === b.d;
}
function abs(a: Rational) {
  return rational(a.n < 0n ? -a.n : a.n, a.d);
}
function lessEqual(a: Rational, b: Rational) {
  return a.n * b.d <= b.n * a.d;
}
/** Deliberately bounded arithmetic grammar, never eval/Function or a CAS parser. */
export function numeric(source: string): Rational {
  let text = source
    .normalize('NFC')
    .replaceAll('−', '-')
    .replaceAll('×', '*')
    .replaceAll('÷', '/')
    .replace(/\s+/g, '');
  if (text.length > 500) throw new GradingError('UNSUPPORTED_EXPRESSION');
  text = text
    .replace(/^\$(.*)\$$/, '$1')
    .replace(/\\(?:left|right)/g, '')
    .replace(/\\(?:times|cdot)/g, '*')
    .replace(/\\div/g, '/')
    .replace(/\\[,!;]/g, '');
  for (let n = 0; n < 16 && /\\(?:[dt]?frac)/.test(text); n++) {
    const next = text.replace(
      /\\[dt]?frac\{([^{}]+)\}\{([^{}]+)\}/g,
      '(($1)/($2))',
    );
    if (next === text) break;
    text = next;
  }
  text = text.replace(/\^\{([0-8])\}/g, '^$1');
  if (text.length > 1000) throw new GradingError('UNSUPPORTED_EXPRESSION');
  const tokens = text.match(/\d+(?:\.\d+)?|[()+*/^\-]/g) ?? [];
  if (!tokens.length || tokens.length > 100 || tokens.join('') !== text)
    throw new GradingError('UNSUPPORTED_EXPRESSION');
  let index = 0;
  function atom(depth: number): Rational {
    if (depth > 16) throw new GradingError('UNSUPPORTED_EXPRESSION');
    let result: Rational;
    const token = tokens[index++];
    if (token === '+' || token === '-') {
      result = atom(depth + 1);
      if (token === '-') result = rational(-result.n, result.d);
    } else if (token === '(') {
      result = expression(depth + 1);
      if (tokens[index++] !== ')')
        throw new GradingError('UNSUPPORTED_EXPRESSION');
    } else if (token && /^\d+(?:\.\d+)?$/.test(token)) {
      const [a, b = ''] = token.split('.');
      if (a.length + b.length > 30)
        throw new GradingError('UNSUPPORTED_EXPRESSION');
      result = rational(BigInt(a + b), 10n ** BigInt(b.length));
    } else throw new GradingError('UNSUPPORTED_EXPRESSION');
    if (tokens[index] === '^') {
      index++;
      const exponent = tokens[index++];
      if (!exponent || !/^[0-8]$/.test(exponent))
        throw new GradingError('UNSUPPORTED_EXPRESSION');
      result = rational(
        result.n ** BigInt(exponent),
        result.d ** BigInt(exponent),
      );
    }
    return result;
  }
  function product(depth: number): Rational {
    let result = atom(depth);
    while (tokens[index] === '*' || tokens[index] === '/') {
      const op = tokens[index++];
      const b = atom(depth);
      result =
        op === '*' ? multiply(result, b) : multiply(result, rational(b.d, b.n));
    }
    return result;
  }
  function expression(depth: number): Rational {
    let result = product(depth);
    while (tokens[index] === '+' || tokens[index] === '-') {
      const op = tokens[index++];
      const b = product(depth);
      result = add(result, op === '+' ? b : rational(-b.n, b.d));
    }
    return result;
  }
  const result = expression(0);
  if (index !== tokens.length) throw new GradingError('UNSUPPORTED_EXPRESSION');
  return result;
}
export function within(
  a: Rational,
  b: Rational,
  absolute: string,
  relative: string,
) {
  const delta = abs(add(a, rational(-b.n, b.d)));
  const absTolerance = numeric(absolute);
  const relTolerance = multiply(abs(b), numeric(relative));
  return lessEqual(delta, absTolerance) || lessEqual(delta, relTolerance);
}
export function matchesForm(text: string, form: string | null) {
  const s = text
    .trim()
    .replace(/^\$(.*)\$$/, '$1')
    .replace(/^\\[dt]?frac\{(-?\d+)\}\{(\d+)\}$/, '$1/$2');
  if (!form) return true;
  if (form === 'integer') return /^-?\d+$/.test(s);
  if (form === 'decimal') return /^-?\d+\.\d+$/.test(s);
  const m = /^(-?\d+)\s*\/\s*(\d+)$/.exec(s);
  if (!m || BigInt(m[2]) === 0n) return false;
  return form === 'fraction' || gcd(BigInt(m[1]), BigInt(m[2])) === 1n;
}
