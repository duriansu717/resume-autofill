/**
 * 文本归一化与别名匹配。
 *
 * 这是整个匹配引擎的地基。DOM 里同一个语义可能写成
 * 「手机号」「手机号码」「联系电话」「mobile」「phoneNum」「user_phone」，
 * 全部要先压成可比对的形态再匹配。
 */
(function (root) {
  'use strict';

  const RA = root.RA;

  /** 全角字符（含全角空格）转半角 */
  function toHalfWidth(s) {
    return s
      .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/　/g, ' ');
  }

  const PUNCT = /[\s *:：()（）\[\]【】{}<>《》〈〉、,，.。;；!！?？'"“”‘’·`~^|/\\\-_+@#$%&]/g;

  /**
   * 归一化：全角转半角 → 小写 → 去掉所有空白与标点。
   * 用于中文别名和宽松的子串匹配。
   */
  function text(s) {
    if (s == null) return '';
    return toHalfWidth(String(s)).toLowerCase().replace(PUNCT, '');
  }

  /**
   * 归一化 + 拆词：camelCase / snake_case / kebab-case 全部拆成空格分隔的词。
   * userName → "user name"，user_name → "user name"。
   * 用于英文别名的词边界匹配。
   */
  function spaced(s) {
    if (s == null) return '';
    let out = toHalfWidth(String(s))
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // userName → user Name
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // HTTPServer → HTTP Server
      .toLowerCase();
    // 非字母数字非中文一律当分隔符
    out = out.replace(/[^a-z0-9一-鿿]+/g, ' ');
    return out.trim();
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const CJK = /[一-鿿]/;

  /**
   * 单个别名在 haystack 里的命中置信度。
   *
   * @param {string} alias      别名，如 '手机号' / 'phone'
   * @param {string} hayNorm    text() 归一化后的 haystack
   * @param {string} haySpaced  spaced() 归一化后的 haystack
   * @returns {number} 0 表示未命中；0.6~1.0 表示命中强度
   */
  function matchAlias(alias, hayNorm, haySpaced) {
    const a = text(alias);
    if (!a || !hayNorm) return 0;

    if (CJK.test(alias)) {
      // 中文没有词边界，只能子串匹配。别名越长越可信：
      // 「出生日期」(4字) 比「日期」(2字) 强得多。
      if (!hayNorm.includes(a)) return 0;
      return Math.min(1, 0.8 + (a.length - 1) * 0.05);
    }

    // 英文优先按词边界匹配，避免 name 命中 username 这类误伤。
    const aSpaced = spaced(alias);
    if (aSpaced && haySpaced) {
      const pat = aSpaced.split(' ').map(escapeRe).join(' ');
      if (new RegExp('(^| )' + pat + '( |$)').test(haySpaced)) return 1;
    }
    // 退化为子串匹配，置信度明显更低
    return hayNorm.includes(a) ? 0.6 : 0;
  }

  /**
   * 在一组别名里找命中强度最高的那个。
   * 长别名优先——「手机号码」命中时不应该被「号码」抢走。
   *
   * @returns {{alias: string, strength: number}|null}
   */
  function bestMatch(aliases, hayNorm, haySpaced) {
    let best = null;
    for (const alias of aliases || []) {
      const s = matchAlias(alias, hayNorm, haySpaced);
      if (s <= 0) continue;
      // 同样命中时，别名更长的更可信
      const rank = s * 100 + String(alias).length;
      if (!best || rank > best._rank) best = { alias, strength: s, _rank: rank };
    }
    if (!best) return null;
    delete best._rank;
    return best;
  }

  /** 命中任意一个别名即返回 true，用于 exclude 黑名单 */
  function anyMatch(aliases, hayNorm, haySpaced) {
    return bestMatch(aliases, hayNorm, haySpaced) !== null;
  }

  const DATE_RE = /^(\d{4})\s*[-/年.]?\s*(\d{1,2})?\s*[-/月.]?\s*(\d{1,2})?/;

  /**
   * 把各种日期写法拆成年月日。
   * '1998-01-01' / '1998/1/1' / '1998年1月' / '1998-01' / Date 对象 → {y,m,d}
   * 缺省的部分为 null（简历里「1998年1月」很常见，日就是 null）。
   */
  function dateParts(value) {
    if (value == null || value === '') return null;

    if (value instanceof Date && !isNaN(value)) {
      return { y: value.getFullYear(), m: value.getMonth() + 1, d: value.getDate() };
    }

    const s = toHalfWidth(String(value)).trim();

    // 纯年份
    if (/^\d{4}$/.test(s)) return { y: +s, m: null, d: null };

    const m = DATE_RE.exec(s);
    if (!m) return null;
    const y = +m[1];
    const mo = m[2] ? +m[2] : null;
    const d = m[3] ? +m[3] : null;
    if (mo != null && (mo < 1 || mo > 12)) return null;
    if (d != null && (d < 1 || d > 31)) return null;
    return { y, m: mo, d };
  }

  /** 补零：7 → '07' */
  function pad2(n) {
    return n == null ? '' : String(n).padStart(2, '0');
  }

  RA.normalize = {
    toHalfWidth,
    text,
    spaced,
    matchAlias,
    bestMatch,
    anyMatch,
    dateParts,
    pad2,
    escapeRe,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
