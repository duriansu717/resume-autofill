/**
 * 诊断信息：把「扩展眼里的这次填写」原样导出来。
 *
 * 为什么需要它：
 * 招聘网站的表单实现千差万别，同一个「学校名称」在 A 站是普通 input、
 * 在 B 站是 AntD Select、在 C 站是自研的弹窗选择器。只说「填不上」，
 * 排查只能靠猜；把扫描到的信号、匹配分数、失败原因、控件 DOM 一起复制出来，
 * 才能一次定位。
 *
 * 设计原则：
 *   · 只导出「结构」和「为什么」，不导出用户隐私（姓名/电话/邮箱等一律隐藏）
 *   · URL 去掉 query / hash，避免把会话 token 带出去
 *   · 体积可控：只给失败/未识别的控件附 DOM 片段，且有上限
 *
 * 入口：填充结果面板底部的「复制诊断」按钮。
 */
(function (root) {
  'use strict';

  const RA = root.RA;

  const MAX_DOM_FIELDS = 15;   // 最多给多少个控件附 DOM 片段
  const MAX_VALUE = 60;        // 值的截断长度
  const MAX_OUTER = 900;       // 单个元素 outerHTML 上限
  const MAX_CONTAINER = 1500;  // 表单项容器上限

  const state = {
    descriptors: [],
    matches: [],
    attempts: [],
    unfilled: [],
  };

  /**
   * 这些字段的值一律不导出。
   * 报告是要发给别人的，学校和公司名对定位问题有用，手机号身份证没有。
   */
  const SENSITIVE_RE = /^basic\.(name|phone|email|idCard|address|birthday|qq|wechat|postalCode)$|^emergencyContact\.|^custom\./;

  const isSensitive = (key) => SENSITIVE_RE.test(String(key || ''));

  function trunc(s, max) {
    const str = s == null ? '' : String(s);
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  function round(n) {
    return typeof n === 'number' ? Math.round(n * 100) / 100 : n;
  }

  function safeValue(key, value) {
    if (isSensitive(key)) return value == null || value === '' ? '' : '（已隐藏）';
    return trunc(value == null ? '' : value, MAX_VALUE);
  }

  // ─────────────────────── 状态收集 ───────────────────────

  function begin() {
    state.descriptors = [];
    state.matches = [];
    state.attempts = [];
    state.unfilled = [];
  }

  function setScan(descriptors, matches) {
    state.descriptors = Array.isArray(descriptors) ? descriptors : [];
    state.matches = Array.isArray(matches) ? matches : [];
  }

  function setUnfilled(els) {
    state.unfilled = Array.isArray(els) ? els : [];
  }

  /** 每次真正调用 writeOne 之后记一条，失败原因比结果面板里的更完整 */
  function recordAttempt(rec) {
    if (!rec) return;
    state.attempts.push(rec);
  }

  // ─────────────────────── 元素与 DOM 快照 ───────────────────────

  function elVisible(el) {
    try {
      if (!el.getClientRects().length) return false;
      const cs = root.getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    } catch (e) {
      return false;
    }
  }

  function rectOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    } catch (e) {
      return null;
    }
  }

  function inShadow(el) {
    try {
      return !!(el.getRootNode && el.getRootNode() !== root.document);
    } catch (e) {
      return false;
    }
  }

  function elInfo(el) {
    if (!el || !el.tagName) return null;
    const attr = (k) => {
      try { return el.getAttribute(k) || ''; } catch (e) { return ''; }
    };
    return {
      tag: String(el.tagName).toLowerCase(),
      type: attr('type'),
      role: attr('role'),
      id: trunc(attr('id'), 60),
      name: trunc(attr('name'), 60),
      readOnly: !!el.readOnly,
      disabled: !!el.disabled,
      visible: elVisible(el),
      rect: rectOf(el),
      inShadow: inShadow(el),
      aria: {
        label: trunc(attr('aria-label'), 60),
        haspopup: attr('aria-haspopup'),
        autocomplete: attr('aria-autocomplete'),
        expanded: attr('aria-expanded'),
      },
    };
  }

  /** 克隆一份 HTML 用于报告：去掉脚本/样式/图片，清空所有用户输入的值 */
  function outerOf(el, max) {
    if (!el || !el.cloneNode) return '';
    try {
      const c = el.cloneNode(true);

      // 清掉用户输入。注意 querySelectorAll 不包含根节点自己——
      // 控件本身就是一个 input 时，它的 value 属性必须单独处理，
      // 否则手机号/身份证会跟着 HTML 一起被复制出去。
      const scrub = (n) => {
        if (!n || n.nodeType !== 1) return;
        const tag = String(n.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          n.removeAttribute('value');
          n.removeAttribute('checked');
          n.removeAttribute('selected');
          if (tag === 'TEXTAREA') n.textContent = '';
        }
        if (tag === 'INPUT' && (n.getAttribute('type') || '').toLowerCase() === 'checkbox') {
          n.removeAttribute('checked');
        }
        if (n.hasAttribute && n.hasAttribute('contenteditable')) n.textContent = '';
      };

      scrub(c);
      c.querySelectorAll('input, textarea, select, [contenteditable]').forEach(scrub);
      c.querySelectorAll('script, style, link, noscript, svg, img, iframe').forEach((n) => n.remove());

      const html = String(c.outerHTML || '').replace(/\s+/g, ' ').trim();
      return trunc(html, max);
    } catch (e) {
      return '';
    }
  }

  function containerOf(el) {
    try {
      return RA.scan && RA.scan.formItemContainer ? RA.scan.formItemContainer(el) : null;
    } catch (e) {
      return null;
    }
  }

  function widgetOf(el) {
    try {
      return el.closest ? el.closest(RA.scan.WIDGET_SEL) : null;
    } catch (e) {
      return null;
    }
  }

  function domFor(d, key) {
    const el = d && d.el;
    if (!el) return null;

    const out = { el: outerOf(el, MAX_OUTER) };

    // 敏感字段的容器里可能用普通文本显示着手机号/姓名（自研组件常见），
    // 没法逐段判断，索性只保留控件本身，不给容器 HTML。
    if (isSensitive(key)) return out;

    const container = containerOf(el);
    const widget = widgetOf(el);
    if (container && container !== el) out.container = outerOf(container, MAX_CONTAINER);
    if (widget && widget !== el && widget !== container) out.widget = outerOf(widget, MAX_CONTAINER);
    return out;
  }

  /** 当前还开着的弹层。填写失败后立刻复制时很有用 */
  function panelsNow() {
    try {
      if (!RA.fill || !RA.fill.visibleDropdowns) return [];
      return RA.fill.visibleDropdowns().slice(0, 6).map((p) => ({
        tag: String(p.tagName || '').toLowerCase(),
        role: (p.getAttribute && p.getAttribute('role')) || '',
        class: trunc((p.className && String(p.className)) || '', 100),
        items: p.querySelectorAll('[role="option"], li').length,
        text: trunc((p.textContent || '').trim(), 160),
      }));
    } catch (e) {
      return [];
    }
  }

  // ─────────────────────── 报告 ───────────────────────

  function signalsOf(d) {
    const s = (d && d.signals) || {};
    return {
      label: trunc(s.labelText || '', 80),
      labelSource: s.labelSource || '',
      placeholder: trunc(s.placeholder || '', 80),
      name: trunc(s.name || '', 60),
      id: trunc(s.id || '', 60),
      type: s.inputType || '',
      class: trunc(s.className || '', 100),
      nearby: (s.nearbyText || []).slice(0, 2).map((t) => trunc(t, 60)),
    };
  }

  function sectionOf(d) {
    const s = d && d.section;
    if (!s) return null;
    return {
      key: s.key || '',
      title: trunc(s.title || '', 40),
      entryIndex: s.entryIndex,
      confidence: round(s.confidence),
    };
  }

  let allKeysCache = null;
  function allKeys() {
    if (!allKeysCache) allKeysCache = (RA.fields.DEFS || []).map((x) => x.key);
    return allKeysCache;
  }

  /** 没匹配上时，看看最接近的是哪几个字段、差多少 */
  function topCandidates(d) {
    try {
      if (!RA.score || !RA.score.scoreField) return [];
      return RA.score.scoreField(d, allKeys()).slice(0, 3).map((c) => ({
        key: c.key,
        score: round(c.score),
        evidence: c.evidence,
      }));
    } catch (e) {
      return [{ error: trunc(e && e.message, 100) }];
    }
  }

  function attemptOf(a) {
    if (!a) return null;
    const key = a.key || (a.d && a.d.raKey) || '';
    return {
      key,
      label: trunc(a.label || '', 60),
      tier: a.tier,
      score: round(a.score),
      manual: !!a.manual,
      ok: !!a.ok,
      reason: a.reason || '',
      via: a.via || '',
      actual: safeValue(key, a.actual),
      value: safeValue(key, a.raw),
      variants: isSensitive(key) ? [] : (a.variants || []).slice(0, 6).map((v) => trunc(v, 40)),
      // 失败时弹层的结构：日期/下拉认不出来时，这一块是定位问题的关键
      panel: a.panel ? {
        tag: trunc(a.panel.tag, 20),
        role: trunc(a.panel.role, 40),
        class: trunc(a.panel.class, 120),
        text: trunc(a.panel.text, 300),
        html: trunc(a.panel.html, 2500),
      } : undefined,
    };
  }

  function pageInfo() {
    let url = '';
    let isTop = null;
    try {
      const loc = root.location;
      url = (loc.origin || '') + (loc.pathname || '');
    } catch (e) { /* 忽略 */ }
    try { isTop = root.top === root.self; } catch (e) { isTop = false; }

    return {
      url: trunc(url, 300),
      title: trunc((root.document && root.document.title) || '', 120),
      isTop,
      viewport: {
        w: root.innerWidth || 0,
        h: root.innerHeight || 0,
        dpr: root.devicePixelRatio || 1,
      },
    };
  }

  function build() {
    try {
      const matchByD = new Map();
      for (const m of state.matches) if (m && m.d) matchByD.set(m.d, m);

      const attemptByEl = new Map();
      for (const a of state.attempts) if (a && a.d && a.d.el) attemptByEl.set(a.d.el, a);

      const unfilledSet = new Set(state.unfilled);

      const priority = [];
      const fields = state.descriptors.map((d, i) => {
        let row;
        try {
          const m = matchByD.get(d) || null;
          const a = attemptByEl.get(d && d.el) || null;
          const def = m ? RA.fields.BY_KEY[m.key] : null;

          row = {
            i,
            el: elInfo(d && d.el),
            signals: signalsOf(d),
            section: sectionOf(d),
            matched: m ? {
              key: m.key,
              label: def ? def.label : '',
              score: round(m.score),
              tier: m.tier,
            } : null,
            attempt: attemptOf(a),
            unfilled: !m || unfilledSet.has(d && d.el),
          };

          const failed = a && !a.ok;
          if (!m || failed) {
            row.candidates = topCandidates(d);
            if (priority.length < MAX_DOM_FIELDS + 20) priority.push(row);
          }
        } catch (e) {
          row = { i, error: trunc(e && e.message, 100) };
        }
        return row;
      });

      // 失败/未识别的控件附上 DOM 片段，其余不附——控制体积
      let budget = MAX_DOM_FIELDS;
      for (const row of priority) {
        if (budget <= 0) break;
        const d = state.descriptors[row.i];
        if (!d) continue;
        try {
          const key = (row.matched && row.matched.key) ||
            (row.attempt && row.attempt.key) || d.raKey || '';
          row.dom = domFor(d, key);
          budget--;
        } catch (e) { /* 单个控件取不到就跳过 */ }
      }

      const failed = state.attempts.filter((a) => a && !a.ok);
      const sections = {};
      for (const d of state.descriptors) {
        const k = (d.section && d.section.key) || 'none';
        sections[k] = (sections[k] || 0) + 1;
      }

      return {
        _type: 'resume-assistant-diag',
        _version: 1,
        time: new Date().toISOString(),
        extension: RA.version || '',
        page: pageInfo(),
        summary: {
          descriptors: state.descriptors.length,
          matched: state.matches.length,
          attempts: state.attempts.length,
          failed: failed.length,
          unfilled: state.unfilled.length,
          sections,
        },
        attempts: state.attempts.map(attemptOf).filter(Boolean),
        fields,
        panels: panelsNow(),
      };
    } catch (e) {
      return {
        _type: 'resume-assistant-diag',
        _version: 1,
        fatal: trunc(e && (e.stack || e.message), 500),
      };
    }
  }

  function format() {
    return JSON.stringify(build(), null, 2);
  }

  async function copy() {
    const text = format();
    const kb = Math.max(1, Math.ceil(text.length / 1024));

    // 首选异步剪贴板（扩展有 clipboardWrite 权限）
    try {
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
        await root.navigator.clipboard.writeText(text);
        return { ok: true, kb };
      }
    } catch (e) { /* 回退 */ }

    // 回退：临时 textarea + execCommand，必须在用户点击的调用栈里
    try {
      const ta = root.document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      root.document.body.appendChild(ta);
      ta.select();
      const ok = root.document.execCommand('copy');
      ta.remove();
      return { ok: !!ok, kb };
    } catch (e) {
      return { ok: false, kb };
    }
  }

  RA.diag = {
    begin,
    setScan,
    setUnfilled,
    recordAttempt,
    build,
    format,
    copy,
    elInfo,
    domFor,
    _state: state,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
