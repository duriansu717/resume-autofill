/**
 * 填充器：把值真正写进控件里。
 *
 * 这个文件里有两处「不做就填不进去」的关键细节：
 *
 *   1. React 受控组件。直接 el.value = x 会被 React 的 _valueTracker
 *      认为是「没变化」，onChange 不触发，提交时值是空的。
 *      必须先绕过原型 setter 写值，再把 tracker 的旧值回填，
 *      让 React 察觉差异。这是 React Testing Library 内部用的同一套写法。
 *
 *   2. blur 事件不冒泡。站点的委托式校验监听的是 focusout，
 *      派发 blur 事件根本到不了它那儿。
 */
(function (root) {
  'use strict';

  const RA = root.RA;
  const N = RA.normalize;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function withTimeout(promise, ms, fallback = null) {
    return Promise.race([
      promise,
      new Promise((r) => setTimeout(() => r(fallback), ms)),
    ]);
  }

  /** 轮询等待某个条件成立，超时返回 null。绝不无限等待。 */
  function waitFor(predicate, timeout = 700, interval = 30) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let r = null;
        try {
          r = predicate();
        } catch (e) {
          r = null;
        }
        if (r) return resolve(r);
        if (Date.now() - start >= timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  // ─────────────────────── 撤销栈 ───────────────────────

  const undoStack = [];

  function record(el, kind, previous, extra = {}) {
    undoStack.push({ el, kind, previous, ...extra });
  }

  /** 还原一条记录。尽力而为，单个失败不影响其余。 */
  function undoOne(item) {
    try {
      const { el, kind, previous } = item;
      if (!el || !el.isConnected) return false;

      if (kind === 'radio-group' || kind === 'checkbox-group') {
        // previousMap 是 [[元素, 是否选中]] 数组。这里必须用数组而不是对象，
        // 对象键会把 DOM 元素强制转成字符串，恢复时就找不回来了。
        for (const [node, wasChecked] of item.previousMap || []) {
          // 走 setNativeChecked 而不是直接赋 checked，
          // 这样撤销也会通知框架，否则页面状态和视觉状态会不一致
          if (node && node.isConnected) setNativeChecked(node, wasChecked);
        }
        return true;
      }

      if (kind === 'contenteditable') {
        el.textContent = previous == null ? '' : previous;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }

      setNativeValue(el, previous == null ? '' : previous);
      return true;
    } catch (e) {
      return false;
    }
  }

  function undoAll() {
    let n = 0;
    while (undoStack.length) {
      if (undoOne(undoStack.pop())) n++;
    }
    // 清理填充时打上的高亮
    if (RA.overlay && RA.overlay.clearMarks) RA.overlay.clearMarks();
    return n;
  }

  /** 只撤销最近一次写入——手动一个个填的时候，一键全撤太重了 */
  function undoLast() {
    while (undoStack.length) {
      const item = undoStack.pop();
      if (undoOne(item)) return { ok: true, el: item.el };
    }
    return { ok: false };
  }

  // ─────────────────────── 核心写值 ───────────────────────

  /**
   * 绕过框架、把值真正写进 DOM 并让框架感知到。
   * @param {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} el
   * @param {string} value
   */
  function setNativeValue(el, value, opts = {}) {
    const strValue = value == null ? '' : String(value);

    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;

    const prev = el.value;
    if (prev === strValue && !opts.force) return true;

    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, strValue);
    else el.value = strValue;

    // React 的实例级 value tracker：不把它「骗」一下，React 会认为值没变
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') {
      try {
        tracker.setValue(prev);
      } catch (e) {
        /* 不同 React 版本内部结构有差异，失败也不致命 */
      }
    }

    if (!opts.silent) {
      try {
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true, composed: true, inputType: 'insertText', data: strValue,
        }));
      } catch (e) {
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }
    return true;
  }

  /**
   * 单选/复选框专用：有意义的状态是 checked，不是 value。
   *
   * 这里不能走 setNativeValue —— 那个函数写的是 value 属性，
   * 而单选按钮的 value 是固定不变的（"男"/"女"），所以「值没变就早退」
   * 的条件永远成立，一个事件都发不出来。必须对 checked 做同样的一套：
   * 绕过原型 setter 写值 + 推回 React 的 tracker + 派发事件。
   */
  function setNativeChecked(el, checked) {
    const prev = el.checked;
    if (prev === checked) return true;

    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (desc && desc.set) desc.set.call(el, checked);
    else el.checked = checked;

    // React 用 _valueTracker 跟踪 radio/checkbox，推回旧值才能让它察觉变化
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') {
      try {
        tracker.setValue(prev ? el.value : '');
      } catch (e) { /* 内部结构随版本变化，失败不致命 */ }
    }

    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  }

  /** focusout 才冒泡；站点监听的是它 */
  function triggerBlur(el) {
    try {
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    } catch (e) {
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
    if (typeof el.blur === 'function') el.blur();
  }

  // ─────────────────────── 值归一与枚举别名 ───────────────────────

  /**
   * 中文下拉框里的选项文字和简历里写的值经常不是一回事：
   * 简历写「本科」，选项是「大学本科」；简历写「男」，选项是「男性」。
   * 这里给出常见枚举的显式对应，相似度匹配搞不定的靠它兜。
   */
  const VALUE_ALIASES = {
    'basic.gender': {
      男: ['男', '男性', 'male', 'M'],
      女: ['女', '女性', 'female', 'F'],
    },
    'educations.degree': {
      高中: ['高中', '普通高中', '高中毕业'],
      中专: ['中专', '中等专业学校'],
      大专: ['大专', '专科', '高职', '大学专科'],
      本科: ['本科', '大学本科', '学士', '全日制本科', '本科毕业'],
      硕士: ['硕士', '硕士研究生', '研究生', '硕士学位'],
      博士: ['博士', '博士研究生', '博士学位'],
    },
    'educations.isFullTime': {
      全日制: ['全日制', '统招', '全日制统招', '普通全日制', '脱产'],
      非全日制: ['非全日制', '在职', '业余', '函授', '网络教育', '成人教育', '自考'],
    },
    'basic.maritalStatus': {
      未婚: ['未婚', '单身'],
      已婚: ['已婚'],
    },
    'basic.politicalStatus': {
      中共党员: ['中共党员', '党员', '中国共产党党员'],
      共青团员: ['共青团员', '团员'],
      群众: ['群众', '普通群众'],
    },
    'jobIntention.jobType': {
      全职: ['全职', '全日制', '全时'],
      实习: ['实习', '实习生'],
      兼职: ['兼职'],
    },
  };

  /** 把简历里的值展开成一组可接受的写法，用于和选项文字比对 */
  function valueVariants(key, value) {
    const v = String(value == null ? '' : value).trim();
    if (!v) return [];
    const table = VALUE_ALIASES[key];
    if (!table) return [v];

    const norm = N.text(v);

    // 先找完全相等的规范值。不能直接做包含判断——
    // 「非全日制」包含「全日制」，先匹配到后者就会展开成错误的候选。
    for (const canonical of Object.keys(table)) {
      if (N.text(canonical) === norm) return table[canonical].concat([v]);
    }

    for (const canonical of Object.keys(table)) {
      const variants = table[canonical];
      if (variants.some((x) => N.text(x) === norm || norm.includes(N.text(x)))) {
        return variants.concat([v]);
      }
    }
    return [v];
  }

  // ─────────────────────── 各类控件的写法 ───────────────────────

  // 前缀匹配，不要用 ^...$ —— 选项文字经常是「请选择学历」这种带后缀的
  const PLACEHOLDER_OPTION_RE = /^(请选择|请选中|请选取|请填写|暂无|please\s*select|select\s*\.{0,3}|-{2,}|—{2,})/i;

  function isPlaceholderOption(o) {
    const v = (o.value || '').trim();
    const t = (o.textContent || '').trim();
    // 只认明确的占位值。早先这里把 value="0" 也当占位，会误伤
    // 「0 年经验」「0 次」这类合法选项。
    if (v === '' || v === '-1') return true;
    return PLACEHOLDER_OPTION_RE.test(t);
  }

  /**
   * 下拉框按「选项文字」匹配，不能只比 value——value 经常是 1/2/3 这种无意义编号。
   *
   * 这里绝对不要先写 sel.value 再调 setNativeValue：
   * setNativeValue 开头有 `prev === strValue 就早退` 的判断，先写会让它直接返回，
   * 结果 input/change 一个都不发、React 的 tracker 也不会被推回旧值。
   * 表现就是「界面上选中了，提交时是空的」——这个坑踩过一次，别再加回来。
   */
  function selectByText(sel, variants) {
    const opts = Array.from(sel.options).filter((o) => !o.disabled && !isPlaceholderOption(o));
    if (!opts.length) return false;

    let best = null;
    let bestScore = 0;

    for (const target of variants) {
      const tn = N.text(target);
      if (!tn) continue;
      for (const o of opts) {
        const cands = [N.text(o.textContent), N.text(o.value), N.text(o.label || '')];
        for (const c of cands) {
          if (!c) continue;
          let s = 0;
          if (c === tn) s = 1;
          else if (c.includes(tn) || tn.includes(c)) {
            s = 0.75 + 0.25 * (Math.min(c.length, tn.length) / Math.max(c.length, tn.length));
          }
          if (s > bestScore) {
            bestScore = s;
            best = o;
          }
        }
      }
    }

    if (!best || bestScore < 0.6) return false;
    // 只走 setNativeValue：它用原型上的 setter 选中选项，并负责派发事件
    return setNativeValue(sel, best.value);
  }

  /** radio / checkbox 组：按选项文字点选 */
  function fillChoiceGroup(d, variants) {
    const opts = d.options || [];
    let best = null;
    let bestScore = 0;

    for (const target of variants) {
      const tn = N.text(target);
      if (!tn) continue;
      for (const o of opts) {
        const on = N.text(o.text);
        if (!on) continue;
        let s = 0;
        if (on === tn) s = 1;
        else if (on.includes(tn) || tn.includes(on)) {
          s = 0.75 + 0.25 * (Math.min(on.length, tn.length) / Math.max(on.length, tn.length));
        }
        if (s > bestScore) {
          bestScore = s;
          best = o;
        }
      }
    }

    if (!best || bestScore < 0.6) return false;

    // 用数组记录而不是对象——对象键会把 DOM 元素转成字符串
    const previousMap = opts.map((o) => [o.el, o.el.checked]);

    try {
      best.el.click(); // 优先用 click，框架监听的是完整合成事件链
    } catch (e) {
      setNativeChecked(best.el, true);
    }
    // click 没能选中（元素被遮挡、被 label 拦截等），退回直接写 checked
    if (!best.el.checked) setNativeChecked(best.el, true);

    return { ok: true, previousMap };
  }

  /** 拆分日期：把 {y,m,d} 分发给年/月/日三个控件 */
  function fillDateCluster(cluster, parts) {
    if (!parts || !parts.y) return false;
    let allOk = true;

    for (const u of cluster.units) {
      const el = u.el;
      let val = null;

      if (u.unit === 'Y') val = String(parts.y);
      else if (u.unit === 'M') val = parts.m != null ? N.pad2(parts.m) : null;
      else if (u.unit === 'D') val = parts.d != null ? N.pad2(parts.d) : null;

      if (val == null) continue; // 简历里只有年月，日这格就留空

      const isSelect = el.tagName === 'SELECT';
      record(el, isSelect ? 'select' : 'text', el.value);

      if (isSelect) {
        // 年份下拉可能写 '2020' 也可能写 '2020年'
        const ok = selectByText(el, [val, val + '年', val + '月', val + '日', String(+val)]);
        if (!ok) allOk = false;
      } else {
        setNativeValue(el, val);
        triggerBlur(el);
      }
    }
    return allOk;
  }

  /** 只读输入框的前置处理——有些日期控件是 readonly，得先摘掉再写 */
  function unwrapReadonly(el) {
    if (!el.readOnly) return () => {};
    const had = el.getAttribute('readonly');
    el.removeAttribute('readonly');
    return () => { if (had != null) el.setAttribute('readonly', had); };
  }

  // ─────────────────────── 自定义组件（尽力而为） ───────────────────────

  /**
   * 弹层里按文字找选项点击。
   * 只认 role=option / 常见的框架选项类名，并且把过长的文字排除掉
   * （菜单里经常混着整段说明文字）。
   */
  const OPTION_SEL = '[role="option"], .ant-select-item-option, .el-select-dropdown__item, ' +
    '.ivu-select-item, .ant-cascader-menu-item, .el-cascader-node, ' +
    '.ant-picker-cell, .el-date-table td, li[class*="option"]';

  /** 面板选择器。很多组件把弹层挂到 body 上，类名五花八门，能列的都列上 */
  const PANEL_SEL = [
    '[role="listbox"]', '[role="menu"]', '[role="tree"]',
    '.ant-select-dropdown', '.ant-picker-panel', '.ant-cascader-dropdown',
    '.el-select-dropdown', '.el-cascader-panel', '.el-autocomplete-suggestion',
    '.ivu-select-dropdown', '.ivu-picker-panel',
    '.arco-select-popup', '.arco-cascader-popup', '.arco-picker-container',
    '.semi-select-option-list', '.semi-portal', '.n-select-menu',
    '.v-binder-follower-content', '.t-select__dropdown', '.t-cascader__panel',
    '.select2-results', '.select2-drop', '.chosen-drop', '.selectize-dropdown',
    '[data-popper-placement]',
    '[class*="dropdown"]', '[class*="popup"]', '[class*="popper"]',
    '[class*="suggest"]', '[class*="autocomplete"]', '[class*="option-list"]',
    '[class*="options-panel"]', '[class*="select-panel"]', '[class*="picker-panel"]',
  ].join(', ');

  function isVisible(el) {
    if (!el || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  /** 元素里有没有「一行一个」的短文本——下拉选项、建议列表都长这样 */
  function hasShortText(el) {
    if (!el) return false;
    for (const node of el.querySelectorAll('div, li, span, td, a')) {
      if (node.children.length) continue;
      const t = (node.textContent || '').trim();
      if (t && t.length <= 40) return true;
    }
    return false;
  }

  /**
   * 没挂约定类名的弹层长什么样：飘在页面上（absolute/fixed）、有尺寸、
   * 里面是一行行短文本。靠这个兜住自研的联想下拉。
   */
  function isPopupLike(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest('[data-ra-ignore]')) return false;
    if (!isVisible(el)) return false;

    const role = (el.getAttribute('role') || '').toLowerCase();
    const cs = getComputedStyle(el);
    const floating = cs.position === 'absolute' || cs.position === 'fixed';
    if (!floating && role !== 'listbox' && role !== 'menu' && role !== 'tree') return false;

    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 16) return false;
    if (r.height > 1400) return false;

    return hasShortText(el);
  }

  /**
   * 把一个新插入 DOM 的节点展开成「可能的弹层」。
   * 组件通常先插一个 portal 容器，弹层在它里面，所以容器本身不合适时往下找一层。
   */
  function popupRoots(nodes, limit = 300) {
    const out = [];
    for (const n of nodes) {
      if (!n || n.nodeType !== 1) continue;

      let best = null;
      const scan = [n].concat(Array.from(n.querySelectorAll('*')).slice(0, limit));
      for (const el of scan) {
        if (isPopupLike(el)) { best = el; break; } // 外层优先，范围更大
      }
      if (best) out.push(best);
    }
    return out;
  }

  /** 新插入节点的观察器：自研弹层没有稳定类名，只能看「点了之后新出现了什么」 */
  function startPanelWatch() {
    const added = [];
    let obs = null;
    try {
      obs = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1) added.push(n);
          }
        }
        // 页面在填表时可能还在刷列表 / 广告，别让数组无限长
        if (added.length > 200) added.splice(0, added.length - 200);
      });
      obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* 没有 body 之类，忽略 */ }

    return {
      take() {
        const fresh = popupRoots(added.splice(0, added.length));
        const vis = visibleDropdowns();
        return fresh.concat(vis);
      },
      stop() { if (obs) obs.disconnect(); },
    };
  }

  /** 两个面板里谁的「选项感」更强——toast / tooltip 也会被当成弹层，得挑对 */
  function panelScore(el) {
    if (!el) return 0;
    const role = (el.getAttribute('role') || '').toLowerCase();
    let s = 0;
    if (role === 'listbox' || role === 'menu' || role === 'tree') s += 10;
    if (el.matches && el.matches(PANEL_SEL)) s += 3;
    s += Math.min(el.querySelectorAll(OPTION_SEL).length, 20);

    let leaves = 0;
    for (const node of el.querySelectorAll('div, li, span, td, a')) {
      if (node.children.length) continue;
      const t = (node.textContent || '').trim();
      if (t && t.length <= 40 && ++leaves >= 20) break;
    }
    return s + Math.min(leaves, 20);
  }

  function pickPanel(list) {
    let best = null;
    let bestScore = 0;
    for (const p of list) {
      if (!p || !p.isConnected || !isVisible(p)) continue;
      const s = panelScore(p);
      if (s > bestScore) { bestScore = s; best = p; }
    }
    return best;
  }

  /** 失败时把弹层结构记下来，诊断报告里能直接看到它长什么样 */
  function panelDebug(panel) {
    if (!panel) return null;
    const cls = String(panel.className && panel.className.baseVal != null
      ? panel.className.baseVal : panel.className || '');
    return {
      tag: String(panel.tagName || '').toLowerCase(),
      role: (panel.getAttribute && panel.getAttribute('role')) || '',
      class: cls.slice(0, 120),
      text: (panel.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300),
      html: String(panel.outerHTML || '').replace(/\s+/g, ' ').slice(0, 2500),
    };
  }

  /** 当前所有「看得见」的下拉面板 */
  function visibleDropdowns() {
    const out = [];
    for (const p of document.querySelectorAll(PANEL_SEL)) {
      if (isVisible(p)) out.push(p);
    }
    return out;
  }

  /** 面板里的选项元素：先认约定标记，再兜底到叶子文本节点 */
  function optionElements(scope) {
    if (!scope) return [];

    const standard = [];
    for (const it of scope.querySelectorAll(OPTION_SEL)) {
      const t = (it.textContent || '').trim();
      if (t && t.length <= 40) standard.push(it);
    }

    const leaves = [];
    for (const el of scope.querySelectorAll('div, li, span, td, a')) {
      if (el.children.length) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 40) continue;
      let covered = false;
      for (const s of standard) {
        if (s === el || s.contains(el)) { covered = true; break; }
      }
      if (!covered) leaves.push(el);
    }

    return standard.concat(leaves);
  }

  /** 面板里是否已经有选项了（异步加载时用得着） */
  function hasOptions(panel) {
    return !!(panel && optionElements(panel).length);
  }

  function bestOption(items, variants) {
    let best = null;
    let bestScore = 0;
    for (const target of variants) {
      const tn = N.text(target);
      if (!tn) continue;
      for (const it of items) {
        const on = N.text(it.textContent);
        if (!on) continue;
        let s = on === tn ? 1
          : (on.includes(tn) || tn.includes(on))
            ? 0.75 + 0.25 * (Math.min(on.length, tn.length) / Math.max(on.length, tn.length))
            : 0;
        if (s > bestScore) { bestScore = s; best = it; }
      }
    }
    return { best, score: bestScore };
  }

  /** 点击一个元素：先滚动到可见区，再补 mousedown/mouseup，最后 click */
  function clickEl(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 忽略 */ }
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    } catch (e) { /* 忽略 */ }
    try {
      el.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  function clickOptionIn(scope, variants) {
    if (!scope) return null;

    const standard = Array.from(scope.querySelectorAll(OPTION_SEL)).filter((it) => {
      const t = (it.textContent || '').trim();
      return t && t.length <= 40;
    });

    let hit = bestOption(standard, variants);
    if (!hit.best || hit.score < 0.6) {
      // 有些组件的选项没有任何 role / 约定类名，只是一串 div / li / span。
      // 找「叶子节点」——文字在它这里结束，点击会冒泡到真正挂事件的父节点。
      const leaves = optionElements(scope).filter((el) => !standard.includes(el));
      const fallback = bestOption(leaves, variants);
      if (fallback.best && fallback.score > hit.score) hit = fallback;
    }
    if (!hit.best || hit.score < 0.6) return null;

    clickEl(hit.best);
    return hit.best;
  }

  /** 让下拉/日期弹层弹出来 */
  function openWidget(host) {
    const trigger = host.querySelector(
      '[role="combobox"], [aria-haspopup="listbox"], [aria-autocomplete], ' +
      '.ant-select-selector, .el-input__inner, .ivu-select-selection, ' +
      '.ant-picker, .el-range-input, input'
    ) || host;

    // 有些实现监听 pointerdown / mousedown 而不是 click；只派发 click 会被忽略
    try {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    } catch (e) { /* 忽略 */ }

    if (typeof trigger.focus === 'function') {
      try { trigger.focus({ preventScroll: true }); } catch (e) { trigger.focus(); }
    }

    try {
      trigger.click();
    } catch (e) { /* 忽略 */ }

    // 部分组件只在键盘事件里展开
    try {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }));
    } catch (e) { /* 忽略 */ }

    return trigger;
  }

  /** 等到一个「点开之后新出现」的面板 */
  async function waitForPanel(watch, before, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const fresh = watch.take().filter((p) => before.indexOf(p) < 0);
      const pick = pickPanel(fresh);
      if (pick) {
        // 刚插进来的面板可能是空的，稍等它把选项渲染出来
        await waitFor(() => hasOptions(pick), 450);
        return pick;
      }
      await sleep(60);
    }
    return null;
  }

  /** 这些字段的值是日期：控件不一定带 date 类名，靠 key 判断更稳 */
  function isDateKey(key) {
    if (!key) return false;
    return /(^|\.)(birthday|startDate|endDate|date)$/.test(key);
  }

  /** 显示值里有没有这个年月（兼容 2021-07 / 2021年7月 / 2021/07/01 等写法） */
  function dateShown(shown, iso) {
    if (!shown) return false;
    const y = iso.slice(0, 4);
    const m = iso.slice(5, 7);
    if (!shown.includes(y)) return false;
    return shown.includes(m) || shown.includes(String(Number(m)));
  }

  function closePanel(trigger) {
    try {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 日期控件：优先「打字 + 回车」。
   * YYYY-MM 和 YYYY-MM-DD 互相回退——月份选择器只认前者，日期选择器一般要后者。
   */
  async function typeDate(host, input, variants) {
    const iso = variants.find((v) => /^\d{4}-\d{2}(-\d{2})?$/.test(v));
    if (!iso) return null;

    const candidates = [iso];
    if (/^\d{4}-\d{2}$/.test(iso)) candidates.push(iso + '-01');
    else candidates.push(iso.slice(0, 7));

    const restore = unwrapReadonly(input);
    record(input, 'text', input.value);

    try {
      for (const v of candidates) {
        setNativeValue(input, v);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        await sleep(150);

        const confirmBtn = host.querySelector('button[class*="ok"], .ant-picker-ok button');
        if (confirmBtn) confirmBtn.click();
        await sleep(130);

        // 控件显示出来的可能是本地化文本（1998年07月15日），不能直接比对原字符串
        const shown = readDisplay(host);
        if (dateShown(shown, v) || sameish(shown, v)) {
          // shown === v 说明可能只是把我们打进去的原文留在框里，
          // 组件未必真的接受了这个日期。本地化的显示才可信。
          const localized = shown !== v;
          return { ok: true, via: 'date-type', value: shown, localized };
        }
      }
    } finally {
      restore();
    }

    return { ok: false, reason: 'date-not-accepted' };
  }

  /** 弹层/控件里找一个能打字的输入框（可搜索下拉的搜索框） */
  function findTypeableInput(host, panel) {
    // readonly 的输入框也可能是搜索框（点开之后才让你打字），调用方会临时摘掉 readonly
    const usable = (inp) => {
      const t = (inp.getAttribute('type') || 'text').toLowerCase();
      if (t !== 'text' && t !== 'search') return false;
      return !inp.disabled;
    };
    const pick = (root) => {
      if (!root || !root.querySelectorAll) return null;
      // 控件本身就是 input 时，querySelectorAll 是找不到自己的
      if (root.matches && root.matches('input') && usable(root)) return root;
      for (const inp of root.querySelectorAll('input')) {
        if (usable(inp)) return inp;
      }
      return null;
    };
    // 弹层里的搜索框优先，其次才是控件自身的
    return pick(panel) || pick(host);
  }

  function optionTexts(panel) {
    if (!panel) return [];
    return optionElements(panel)
      .slice(0, 30)
      .map((it) => (it.textContent || '').trim());
  }

  function sameTexts(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** 面板可能被组件重渲染成新节点，用之前重新确认一下 */
  function livePanel(panel) {
    if (panel && panel.isConnected && isVisible(panel)) return panel;
    return pickPanel(visibleDropdowns()) || panel;
  }

  /**
   * 可搜索的下拉：列表是虚拟滚动的/远端的，不输入就找不到目标项。
   * 往搜索框里打关键字，等列表过滤之后再点。
   *
   * 关键细节：
   *   · 远端搜索普遍有 300ms 以上的防抖，输入后立刻点只会点到旧列表——
   *     必须轮询等「列表真的变了」再去点，不能睡 180ms 就下结论
   *   · 输入之后组件可能把面板整个换成新节点，所以点之前重新取一次
   *   · 列表始终没变化说明这个输入框不是搜索框，别再打了
   *   · 失败时把输入框恢复原样，不能直接清空——有的组件里它就是显示值
   */
  async function typeToFilter(host, panel, variants) {
    const input = findTypeableInput(host, panel);
    if (!input) return false;

    const original = input.value;
    const beforeTexts = optionTexts(panel);
    const restore = unwrapReadonly(input);

    try {
      for (const v of variants) {
        if (!v) continue;
        const probe = v.length > 8 ? v.slice(0, 8) : v;
        try { setNativeValue(input, probe); } catch (e) { continue; }

        try {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }));
        } catch (e) { /* 忽略 */ }

        const changed = await waitFor(() => {
          const fresh = livePanel(panel);
          const opts = optionTexts(fresh);
          if (opts.length && !sameTexts(beforeTexts, opts)) return fresh;
          return null;
        }, 1200);

        if (clickOptionIn(changed || livePanel(panel), variants)) return true;

        if (!changed) break; // 列表一直没变，这不是搜索框
      }

      try { setNativeValue(input, original); } catch (e) { /* 忽略 */ }
      return false;
    } finally {
      restore();
    }
  }

  /**
   * 点开没反应时的第二条路：先输入关键字，把联想列表「搜」出来。
   * 学校名称、公司名称这类远端联想输入只有输入之后才会出现候选。
   */
  async function typeToOpenPanel(host, variants, watch, beforePanels) {
    const input = findTypeableInput(host, null);
    if (!input) return null;

    const original = input.value;
    const restore = unwrapReadonly(input);

    let found = null;
    try {
      for (const v of variants) {
        if (!v) continue;
        const probe = v.length > 10 ? v.slice(0, 10) : v;
        try { setNativeValue(input, probe); } catch (e) { continue; }

        // 有的组件监听 keyup 才发请求
        try {
          input.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
        } catch (e) { /* 忽略 */ }

        found = await waitForPanel(watch, beforePanels, 1000);
        if (found) break;
      }
    } finally {
      restore();
    }

    if (!found) {
      // 没搜出来就还原，别把用户原来选中的内容抹掉
      try { setNativeValue(input, original); } catch (e) { /* 忽略 */ }
    }

    return found;
  }

  /** 级联面板（省 → 市 → 区）：逐列点，点完一列下一列才会出现 */
  async function clickCascader(panel, path) {
    let any = false;

    for (const part of path) {
      if (!part) break;

      const cols = panel.querySelectorAll('.ant-cascader-menu, .el-cascader-menu');
      const scope = cols.length ? cols[cols.length - 1] : panel;
      const hit = clickOptionIn(scope, [String(part)]);
      if (!hit) break;

      any = true;
      await sleep(200);
    }

    return any;
  }

  // ─────────────────────── 年月选择器 ───────────────────────

  const CN_MONTH = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
    七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
  };

  function yearOfText(t) {
    if (!/^(19|20)\d{2}\s*年?$/.test(t)) return 0;
    return parseInt(t, 10) || 0;
  }

  function monthOfText(t) {
    let m = /^(\d{1,2})\s*月$/.exec(t);
    if (m) {
      const n = +m[1];
      return n >= 1 && n <= 12 ? n : 0;
    }
    m = /^([一二三四五六七八九十]{1,3})月$/.exec(t);
    if (m) return CN_MONTH[m[1]] || 0;
    return 0;
  }

  /** 面板里的年 / 月格子。文字必须「只有一个年份/月份」，排除整块容器 */
  function dateCells(scope, kind) {
    const out = [];
    if (!scope) return out;
    for (const el of scope.querySelectorAll('td, li, div, span, button, a')) {
      if (!isVisible(el)) continue;

      // 标题栏上的「2021年 / 7月」是切换视图的按钮，不是格子
      const cls = String(el.className && el.className.baseVal != null
        ? el.className.baseVal : el.className || '');
      if (/header|year-btn|month-btn|picker-btn/i.test(cls)) continue;

      const t = (el.textContent || '').trim();
      if (!t || t.length > 8) continue;
      const v = kind === 'year' ? yearOfText(t) : monthOfText(t);
      if (!v) continue;
      // 内含多个格子 / 交互控件的容器不要去点（标题栏常常就是这种）
      if (el.querySelector && el.querySelector('td, li, [role="option"], .ant-picker-cell, button, a, input')) continue;

      // 格子一般很小；标题栏整行都比较宽
      try {
        const r = el.getBoundingClientRect();
        if (r.width > 170 || r.height > 70) continue;
      } catch (e) { /* 忽略 */ }

      out.push(kind === 'year' ? { el, year: v } : { el, month: v });
    }
    return out;
  }

  /** 年月选择器标题栏上的「当前年份」——点它一般会展开年份表格 */
  function headerYearCell(scope) {
    if (!scope) return null;
    for (const el of scope.querySelectorAll('div, span, button, a, td')) {
      if (!isVisible(el)) continue;
      const t = (el.textContent || '').trim();
      const y = yearOfText(t);
      if (!y) continue;
      // 只要真正承载文字的叶子节点，点外层容器不一定触发切换
      if (el.children.length) continue;
      try {
        const r = el.getBoundingClientRect();
        if (r.width > 170 || r.height > 70) continue;
      } catch (e) { /* 忽略 */ }
      return { el, year: y };
    }
    return null;
  }

  /**
   * 年月选择器：面板是「年份表格 + 月份表格」，通用按选项文字匹配对不上
   * （选项文字是「2021年」「7月」，简历里的值是「2021-07」）。
   *
   * 处理三种形态：
   *   · 年份表格先出现（或年、月两列同时出现）→ 点年份，再点月份
   *   · 直接是月份表格，标题上有当前年份 → 年份不对就点标题展开年份表格
   *   · 找不到年份表格 → 放弃，交给后面的通用逻辑
   */
  async function pickYearMonth(panel, variants, host) {
    const iso = variants.find((v) => /^\d{4}-\d{2}(-\d{2})?$/.test(v));
    if (!iso) return null;

    const year = +iso.slice(0, 4);
    const month = +iso.slice(5, 7);
    if (!year || !month) return null;

    let p = panel;

    // A. 年份表格已经可见：先选年（两列布局也走这里）。
    //    至少 4 个年份才算表格——标题栏里的单个「2022年」不算。
    const years = dateCells(p, 'year');
    if (years.length >= 4) {
      const yc = years.find((c) => c.year === year);
      if (!yc) return null; // 目标年不在当前窗口，不做危险的翻页猜测
      clickEl(yc.el);
      await sleep(220);
      p = livePanel(panel);
      await waitFor(() => dateCells(p, 'month').length >= 6, 700);
    }

    // B. 月份格子
    if (dateCells(p, 'month').length < 6) return null;

    // 年份标题对不上：点标题展开年份表格，再点目标年
    const hy = headerYearCell(p);
    if (hy && hy.year !== year) {
      clickEl(hy.el);
      await sleep(220);
      p = livePanel(panel);
      await waitFor(() => dateCells(p, 'year').length >= 4, 700);

      const yc = dateCells(p, 'year').find((c) => c.year === year);
      if (!yc) return null;
      clickEl(yc.el);
      await sleep(220);
      p = livePanel(panel);
      await waitFor(() => dateCells(p, 'month').length >= 6, 700);
    }

    const mc = dateCells(p, 'month').find((c) => c.month === month);
    if (!mc) return null;

    clickEl(mc.el);
    await sleep(200);

    const after = readDisplay(host);
    if (dateShown(after, iso) || sameish(after, iso)) {
      return { ok: true, via: 'month-picker', value: after };
    }
    return null;
  }

  /** 面板是不是「日历日格」——有 20 个以上 1~31 的数字格子 */
  function looksLikeDayGrid(scope) {
    if (!scope) return false;
    let n = 0;
    for (const el of scope.querySelectorAll('td, div, span')) {
      if (el.children.length) continue;
      const t = (el.textContent || '').trim();
      if (!/^\d{1,2}$/.test(t)) continue;
      const v = +t;
      if (v >= 1 && v <= 31 && ++n >= 20) return true;
    }
    return false;
  }

  /**
   * 自定义组件填充。识别不出就放弃并如实报告——
   * 卡住整个流程比填不上一个字段糟糕得多。
   *
   * ctx 是字段描述符（可选）。带上 raKey / regionPath 之后能多处理两种形态：
   *   · 日期控件：按字段 key 判断，不依赖类名
   *   · 省市区级联树：按 省 → 市 → 区 逐列点击
   */
  async function customWidget(host, variants, originalEl, ctx) {
    const before = readDisplay(host);
    const key = ctx && ctx.raKey;

    // 1) 内层藏着一个真 <select>（不少站点保留隐藏 select 做表单提交）
    const inner = host.querySelector('select');
    if (inner && inner.options.length > 1) {
      record(inner, 'select', inner.value);
      return selectByText(inner, variants) ? { ok: true, via: 'inner-select' } : { ok: false, reason: 'inner-select-no-match' };
    }

    // 2) 日期类控件优先「打字」而不是「点日历格子」——点格子依赖本地化和虚拟滚动，太脆
    const dateInput = host.querySelector('input') ||
      (host.matches && host.matches('input') ? host : null);
    const isDateWidget = dateInput && (
      /(ant-picker|el-date-editor|date)/i.test(host.className + ' ' + dateInput.className) ||
      isDateKey(key)
    );

    // 打字成功但显示还是原文（没有变成「2021年09月」）时不可全信：
    // 可能只是我们写进了输入框，组件并没有接住。继续走面板点年月，
    // 面板路线也走不通时再退回打字结果。
    let typed = null;
    let openedByTyping = [];
    if (isDateWidget) {
      const prePanels = visibleDropdowns();
      const r = await typeDate(host, dateInput, variants);
      // 有些日期控件在输入时会顺手把面板弹出来，别再去点一下把它关掉
      openedByTyping = visibleDropdowns().filter((p) => prePanels.indexOf(p) < 0);
      if (r && r.ok && r.localized) return r;
      if (r && r.ok) typed = r;
    }

    // 3) 通用：点开 → 等弹层
    // 先记下点开之前已经开着的面板，等下优先挑「新出现」的那个。
    // 页面上同时挂着好几个下拉时，取第一个会点错地方。
    // 自研的弹层没有稳定类名，所以同时观察「点了之后新插入了什么」。
    const beforePanels = visibleDropdowns();
    const watch = startPanelWatch();

    let trigger = null;
    let panel = null;
    try {
      // 打字时已经弹出来的日期面板直接用，再点一次会把它收起来
      if (openedByTyping.length) {
        panel = pickPanel(openedByTyping);
        trigger = dateInput || host;
      } else {
        trigger = openWidget(host);
        panel = await waitForPanel(watch, beforePanels, 700);

        // 3.0) 联想下拉：点开没反应，必须先输入关键字才会去远端搜索
        //      （学校名称、公司名称最常见的就是这种）
        //      日期控件上面已经试过打字了，不用再来一遍
        if (!panel && !isDateWidget) {
          panel = await typeToOpenPanel(host, variants, watch, beforePanels);
        }
      }
    } finally {
      watch.stop();
    }

    if (!panel) {
      // 面板打不开但打字时把值放进去了，还是按打字结果走（由回读复查兜底）
      if (typed) return typed;
      return { ok: false, reason: 'panel-not-opened' };
    }

    // 面板出现 ≠ 选项渲染完了——很多站点的选项是异步拉取的
    await waitFor(() => hasOptions(panel), 800);

    // 3.1) 省市区级联树：面板里是多列，按 省 → 市 → 区 逐列点
    const isCascader = /cascader/i.test(String(panel.className || '')) ||
      !!panel.querySelector('.ant-cascader-menu, .el-cascader-menu');
    const regionPath = (ctx && Array.isArray(ctx.regionPath)) ? ctx.regionPath : null;

    if (isCascader && regionPath && regionPath.filter(Boolean).length >= 2) {
      const ok = await clickCascader(panel, regionPath);
      await sleep(140);

      const after = readDisplay(host);
      if (ok && after !== before) return { ok: true, via: 'cascader', value: after };

      const dbg = panelDebug(panel);
      closePanel(trigger);
      return { ok: false, reason: 'cascader-not-matched', panel: dbg };
    }

    // 3.1b) 年月选择器：面板是年份/月份表格，按选项文字匹配对不上
    if (isDateWidget) {
      const ym = await pickYearMonth(panel, variants, host);
      if (ym) return ym;

      // 完整日历的日格子：不要退回「按选项文字点」。变体 2021-09-15 里含有
      // "15"，会被当成日格子点下去——月份/年份没选对时这就是填错数据。
      if (looksLikeDayGrid(panel)) {
        // 如果打字时值已经写进去了，关掉日历再确认一次它没被清空
        if (typed) {
          closePanel(trigger);
          try { if (trigger && trigger.blur) trigger.blur(); } catch (e) { /* 忽略 */ }
          await sleep(180);
          const shown = readDisplay(host);
          if (shown && (sameish(shown, typed.value) || dateShown(shown, typed.value))) {
            return typed;
          }
        }

        const dbg = panelDebug(panel);
        closePanel(trigger);
        return { ok: false, reason: 'date-calendar-unhandled', panel: dbg };
      }

      if (typed) return typed; // 面板路线不通，退回打字结果
    }

    // 3.2) 普通下拉：先直接点，点不到再输入关键字过滤（可搜索下拉）
    let clicked = clickOptionIn(panel, variants);
    if (!clicked) {
      clicked = await typeToFilter(host, panel, variants);
    }
    if (!clicked) {
      // 列表可能刚加载完，再给一次机会
      await sleep(250);
      clicked = clickOptionIn(panel, variants);
    }

    await sleep(120);

    if (!clicked) {
      // 关掉弹层，免得挡住用户视线；结构先记进诊断报告
      const dbg = panelDebug(panel);
      closePanel(trigger);
      return { ok: false, reason: 'option-not-found', panel: dbg };
    }

    // 组件更新显示值可能有延迟，别立刻下结论
    const after = (await waitFor(() => {
      const v = readDisplay(host);
      return v && v !== before ? v : null;
    }, 500)) || readDisplay(host);

    return { ok: true, via: 'click-recipe', value: after };
  }

  /**
   * 日期区间 / 时间范围组件的根节点里通常有两个可见控件。
   * 如果直接把整个根节点当 host，两个字段会抢同一个 input。
   * 这里缩小到「只包住当前控件」的最近祖先。
   */
  function liveControlCount(node) {
    let n = 0;
    if (!node || !node.querySelectorAll) return n;
    for (const c of node.querySelectorAll('input, select, textarea')) {
      const type = (c.getAttribute('type') || '').toLowerCase();
      if (type === 'hidden') continue;
      const cls = String(c.className && c.className.baseVal != null ? c.className.baseVal : c.className || '');
      if (/hidden/i.test(cls)) continue;
      const r = c.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      n++;
    }
    return n;
  }

  function narrowHost(el, host) {
    if (!host || liveControlCount(host) <= 1) return host;
    let node = el.parentElement;
    while (node && node !== host && node !== document.body) {
      if (liveControlCount(node) === 1) return node;
      node = node.parentElement;
    }
    return host;
  }

  /** 读自定义组件当前显示的文字 */
  function readDisplay(host) {
    if (!host) return '';
    // host 本身可能就是那个 input（比如带 aria-autocomplete 的联想输入框）
    if (host.matches && host.matches('input, textarea')) return host.value || '';
    const inp = host.querySelector('input');
    if (inp && inp.value) return inp.value;
    const t = (host.textContent || '').trim();
    return t.length <= 60 ? t : '';
  }

  // ─────────────────────── 主写入流程 ───────────────────────

  function readBack(d) {
    if (d.kind === 'radio-group' || d.kind === 'checkbox-group') {
      const checked = (d.options || []).filter((o) => o.el.checked).map((o) => o.text);
      return checked.join(' / ');
    }
    if (d.kind === 'date-cluster') {
      return d.cluster.units.map((u) => u.el.value).join('-');
    }
    return d.el.value;
  }

  /** 值是不是「写进去了」——容错比对，避免格式微差被误判为失败 */
  function sameish(a, b) {
    const x = N.text(a);
    const y = N.text(b);
    if (!x) return false;
    if (x === y) return true;
    return x.includes(y) || y.includes(x);
  }

  /**
   * 这个字段是不是很可能有「输入之后才出现的联想列表」。
   * 网申里学校、公司、专业这几项最常见做成远端搜索，必须选中候选才算数。
   * 判断宁宽勿窄——只是多看一会儿有没有弹层，没有就照常当普通输入框处理。
   */
  function mayAutocomplete(d) {
    if (!d) return false;
    const s = d.signals || {};

    if (s.autocomplete && s.autocomplete !== 'off') return true;

    try {
      if (d.el && d.el.getAttribute && d.el.getAttribute('aria-autocomplete')) return true;
    } catch (e) { /* 忽略 */ }

    const key = d.raKey || '';
    if (/(^|\.)(school|company|major|university|college)$/.test(key)) return true;

    const hint = (s.placeholder || '') + ' ' + (s.labelText || '');
    if (/搜索|请输入|输入/.test(hint) && /学校|院校|公司|专业|岗位|职位/.test(hint)) return true;

    return false;
  }

  /** 明确是「选择器」的容器。往它们的搜索框里塞文字而不选中，站点不会认 */
  const SELECTISH_RE = /ant-select|el-select|ivu-select|arco-select|semi-select|n-select|t-select|select2|chosen-container|selectize/;

  function isSelectish(host) {
    if (!host) return false;
    const cls = String(host.className && host.className.baseVal != null
      ? host.className.baseVal : host.className || '');
    const role = host.getAttribute ? (host.getAttribute('role') || '') : '';
    return SELECTISH_RE.test(cls + ' ' + role);
  }

  /**
   * 普通文本框的写入，顺带处理「联想输入」：
   * 写值之后如果弹出了候选列表，就把完全一致的那一项点掉——
   * 不点的话，不少站点会认为你只是打了几个字，没有真正选中学校/公司。
   */
  async function fillTextInput(input, variants, primary, opts = {}) {
    const maySuggest = !!opts.maySuggest;
    let watch = null;
    let beforePanels = null;

    // 观察器要在 focus 之前挂上：有的联想组件一获得焦点就弹出空面板，
    // 之后的候选项是渲染进这个已存在的面板里的，不能把它算成「点开前就有」。
    if (maySuggest) {
      beforePanels = visibleDropdowns();
      watch = startPanelWatch();
    }

    try { input.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }
    record(input, 'text', input.value);

    let result = { ok: true, via: 'native', written: primary };
    try {
      setNativeValue(input, primary);

      if (maySuggest) {
        const panel = await waitForPanel(watch, beforePanels, 900);
        if (panel) {
          await waitFor(() => hasOptions(panel), 700);

          let hit = clickOptionIn(panel, variants);
          if (!hit) hit = await typeToFilter(input, panel, variants);
          if (hit) {
            await sleep(150);
            result = { ok: true, via: 'autocomplete', written: primary };
          }
        }
      }
    } finally {
      if (watch) watch.stop();
    }

    triggerBlur(input);
    return result;
  }

  /**
   * 往一个控件写值。
   * @returns {Promise<{ok:boolean, reason?:string, via?:string, written:string}>}
   */
  async function writeOne(d, variants, rawValue) {
    const primary = String(rawValue == null ? '' : rawValue);

    try {
      if (typeof d.el.scrollIntoView === 'function') {
        d.el.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    } catch (e) { /* 某些环境下会抛，无所谓 */ }

    let result;

    if (d.kind === 'date-cluster') {
      const parts = N.dateParts(primary);
      if (!parts) return { ok: false, reason: 'bad-date', written: '' };
      // 撤销记录由 fillDateCluster 内部逐格写入，这里不要重复记
      const ok = fillDateCluster(d.cluster, parts);
      result = { ok, reason: ok ? undefined : 'date-part-missing', via: 'date-cluster', written: primary };
    } else if (d.kind === 'select') {
      record(d.el, 'select', d.el.value);
      const ok = selectByText(d.el, variants);
      result = { ok, reason: ok ? undefined : 'no-matching-option', via: 'select', written: primary };
    } else if (d.kind === 'radio-group' || d.kind === 'checkbox-group') {
      const r = fillChoiceGroup(d, variants);
      if (r && r.ok) {
        record(d.el, d.kind, null, { els: d.options.map((o) => o.el), previousMap: r.previousMap });
        result = { ok: true, via: 'click', written: primary };
      } else {
        result = { ok: false, reason: 'no-matching-option', written: primary };
      }
    } else if (d.kind === 'contenteditable') {
      d.el.focus();
      const prev = d.el.textContent;
      record(d.el, 'contenteditable', prev);
      try {
        document.execCommand('insertText', false, primary);
      } catch (e) {
        d.el.textContent = primary;
      }
      d.el.dispatchEvent(new Event('input', { bubbles: true }));
      result = { ok: true, via: 'contenteditable', written: primary };
    } else {
      // 自定义组件：真正干活的是外面那层 div，内层 input 只是摆设
      // （通常 readonly，甚至是零尺寸或 opacity:0）
      let host = null;
      try {
        host = d.el.closest(RA.scan.WIDGET_SEL);
      } catch (e) { /* 选择器不支持就算了 */ }

      const hiddenInput = d.el.readOnly || d.signals.inputType === 'hidden' ||
        getComputedStyle(d.el).opacity === '0' ||
        (d.el.getBoundingClientRect().width === 0 && !!host);

      if (host || hiddenInput) {
        // 日期区间组件根节点里有两个日期控件，先缩到当前控件自己的容器
        const targetHost = host ? narrowHost(d.el, host) : d.el.parentElement;
        const r = await customWidget(targetHost, variants, d.el, d);

        // 点不开面板不代表没救：控件本身就是可编辑的 input 时，
        // 直接把值打进去也能用（站点通常会在这时把候选列表拉出来）。
        // 但明确是 select 的容器不要这么干——塞进去的文字站点不会认。
        const canTypeFallback = !r.ok && d.el.matches &&
          d.el.matches('input') && !d.el.readOnly && !d.el.disabled &&
          (mayAutocomplete(d) || !isSelectish(host));

        if (canTypeFallback) {
          const r2 = await fillTextInput(d.el, variants, primary, { maySuggest: true });
          result = {
            ok: !!r2.ok,
            reason: r2.ok ? undefined : (r.reason || r2.reason),
            via: r2.ok ? (r2.via || 'native-fallback') : 'custom',
            written: primary,
            panel: r.panel,
          };
        } else {
          result = {
            ok: !!r.ok,
            reason: r.reason,
            via: r.via || 'custom',
            written: primary,
            panel: r.panel,
          };
        }
      } else {
        result = await fillTextInput(d.el, variants, primary, { maySuggest: mayAutocomplete(d) });
      }
    }

    // ── 填完复查：框架重渲染经常把值冲掉，必须回读确认 ──
    if (result.ok) {
      await sleep(90);

      // 下拉框单独判断：选中值可能是 "1" 这种编码，跟简历里的文字对不上，
      // 没法直接比对。但必须确认它没被打回「请选择」那个占位项——
      // 否则会报成成功，实际提交时是空的。
      if (d.kind === 'select') {
        const opt = d.el.options[d.el.selectedIndex];
        if (!opt || isPlaceholderOption(opt)) {
          return { ok: false, reason: 'select-reset', written: '' };
        }
        result.actual = opt.textContent.trim();
        return result;
      }

      let now = readBack(d).trim();

      // 日期控件显示的是「2021年09月」这类本地化文本，跟简历里的 2021-09
      // 本来就不相等。这里绝不能走下面的「重试写入」——那会把控件刚转换好的
      // 显示值又覆写成原文，等于把选中的日期冲掉。
      if (isDateKey(d.raKey) && d.kind !== 'date-cluster') {
        if (now && (sameish(now, primary) || dateShown(now, primary))) {
          result.actual = now;
          return result;
        }
        return { ok: false, reason: 'date-mismatch', written: '' };
      }

      if (!sameish(now, primary) && d.kind !== 'select' && d.kind !== 'date-cluster') {
        // 重试一次
        await sleep(200);
        if (d.kind === 'text' || d.kind === 'textarea') {
          setNativeValue(d.el, primary);
          triggerBlur(d.el);
          await sleep(120);
          now = readBack(d).trim();
        }
      }
      if (!sameish(now, primary) && !now) {
        return { ok: false, reason: 'value-reverted', written: '' };
      }
      result.actual = now;
    }

    return result;
  }

  // ─────────────────────── 从简历里取值 ───────────────────────

  // 数组类的顶层字段名从字段表里取，别手写——之前只写了 educations|works|projects，
  // 实习、证书、语言、获奖、竞赛、校园、培训、学生干部、IT 技能全都取不到值
  const ARRAY_GROUP_RE = new RegExp(
    '^(' + Object.keys(RA.fields.ARRAY_NAME_BY_SECTION)
      .map((k) => RA.fields.ARRAY_NAME_BY_SECTION[k])
      .join('|') + ')\\.(.+)$'
  );

  /**
   * 把 key + 条目下标解析成实际要填的值。
   * 有些字段简历里没写，但能从别的字段推出来（身份证 → 生日/性别，生日 → 年龄）。
   */
  function valueFor(profile, key, entryIndex) {
    if (!profile) return null;

    // 自定义字段：数据存在 profile.custom[字段id] 下
    if (key.indexOf('custom.') === 0) {
      const id = key.slice('custom.'.length);
      const custom = profile.custom;
      const v = custom && typeof custom === 'object' ? custom[id] : null;
      return v == null || v === '' ? null : v;
    }

    const arrMatch = ARRAY_GROUP_RE.exec(key);
    if (arrMatch) {
      const arr = profile[arrMatch[1]];
      const item = Array.isArray(arr) ? arr[entryIndex || 0] : null;
      if (!item) return null;
      const v = item[arrMatch[2]];
      return v == null || v === '' ? null : v;
    }

    const dot = key.indexOf('.');
    if (dot < 0) return null;
    const group = profile[key.slice(0, dot)];
    if (!group || typeof group !== 'object') return null;
    let v = group[key.slice(dot + 1)];

    if (v == null || v === '') {
      // 派生值
      if (key === 'basic.age') {
        const age = RA.storage.deriveAge(profile.basic && profile.basic.birthday);
        return age == null ? null : String(age);
      }
      if (key === 'basic.gender' || key === 'basic.birthday') {
        const d = RA.storage.deriveFromIdCard(profile.basic && profile.basic.idCard);
        if (d) v = d[key === 'basic.gender' ? 'gender' : 'birthday'];
      }
    }

    return v == null || v === '' ? null : v;
  }

  RA.fill = {
    setNativeValue,
    setNativeChecked,
    triggerBlur,
    selectByText,
    fillChoiceGroup,
    fillDateCluster,
    customWidget,
    writeOne,
    valueFor,
    valueVariants,
    isDateKey,
    mayAutocomplete,
    fillTextInput,
    visibleDropdowns,
    readBack,
    sameish,
    undoAll,
    undoLast,
    waitFor,
    withTimeout,
    sleep,
    _undoStack: undoStack,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
