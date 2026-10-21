/**
 * 入口：串起扫描 → 区块标注 → 打分分配 → 填充 → 结果面板。
 *
 * 内容脚本只在页面加载时注册监听器，不做任何扫描。
 * 真正干活由用户点扩展图标触发，避免拖慢每个网页、也避免在无关页面上乱读 DOM。
 *
 * 页面可能在 iframe 里（很多招聘网站都这样）。manifest 开了 all_frames，
 * 每个 frame 都会跑这份脚本；popup 那边逐帧发消息，只有有表单的帧会应答。
 */
(function (root) {
  'use strict';

  const RA = root.RA;

  // 单页应用重新注入、或者手动重新加载扩展时，这份脚本可能被执行两次。
  // 重复注册 onMessage 会导致一个消息被应答两次，必须挡住。
  if (RA.__mainLoaded) return;
  RA.__mainLoaded = true;

  // ─────────────────────── 本次会话的填充记录 ───────────────────────
  // 结果面板展示累计填了什么，而不只是最后一次。
  let sessionRows = [];
  const sessionStats = { high: 0, low: 0, fail: 0, skip: 0, unfilled: 0 };
  /** 自动模式没认出来的控件，用紫色虚线标出来引导用户手动处理。 */
  let unfilledEls = [];

  function resetSession() {
    sessionRows = [];
    sessionStats.high = 0;
    sessionStats.low = 0;
    sessionStats.fail = 0;
    sessionStats.skip = 0;
    sessionStats.unfilled = 0;
    unfilledEls = [];
  }

  // ─────────────────────── 扫描 ───────────────────────

  function freshScan(rootEl) {
    const descriptors = RA.scan.collectFields(rootEl || document);
    RA.section.annotate(descriptors);
    return descriptors;
  }

  // ─────────────────────── 重复块：补足条目数 ───────────────────────

  /** 找某个区块的「添加」按钮 */
  function findAddButtonFor(sectionKey, descriptors) {
    const inSection = descriptors.filter((d) => d.section && d.section.key === sectionKey);
    if (!inSection.length) return null;

    for (const d of inSection) {
      const root = d.section.rootEl;
      if (root) {
        const btn = RA.section.findAddButton(root);
        if (btn) return btn;
      }
    }
    for (const d of inSection) {
      let node = d.el.parentElement;
      for (let i = 0; i < 5 && node && node !== document.body; i++) {
        const btn = RA.section.findAddButton(node);
        if (btn) return btn;
      }
    }
    return null;
  }

  /** 统计页面上每个经历区块目前有几条 */
  function countEntries(descriptors) {
    const counts = Object.create(null);
    for (const sec of RA.fields.REPEATING_SECTIONS) {
      const items = descriptors.filter(
        (d) => !d.consumed && d.section && d.section.key === sec
      );
      if (!items.length) {
        counts[sec] = 0;
        continue;
      }
      let maxIdx = -1;
      for (const d of items) {
        const i = d.section.entryIndex || 0;
        if (i > maxIdx) maxIdx = i;
      }
      counts[sec] = maxIdx + 1;
    }
    return counts;
  }

  /**
   * 简历里写了 3 段工作经历，页面上只显示了 1 条输入框时，
   * 需要点「添加」把剩下两条的输入框克隆出来。
   *
   * 两条铁律：
   *   1. 每点一次「添加」都要重新扫描——点按钮会把整个列表重建，
   *      之前拿到的所有元素引用全部失效
   *   2. 每一轮都有次数上限和超时，绝不能无限循环
   */
  async function ensureEntries(profile, settings) {
    const maxAdd = Math.max(0, settings.maxAutoAdd | 0);
    if (!maxAdd) return { added: 0, limited: false };

    let added = 0;
    let limited = false;

    for (let round = 0; round < maxAdd; round++) {
      let descriptors;
      try {
        descriptors = RA.section.annotate(RA.scan.collectFields(document));
      } catch (e) {
        break;
      }

      const counts = countEntries(descriptors);

      // 只考虑页面上真正出现的区块。简历里写了项目经历但页面根本没有这一栏，
      // 那不是「填不下」，是不适用，不该报成限制。
      let target = null;
      let deficit = 0;
      for (const sec of RA.fields.REPEATING_SECTIONS) {
        const have = counts[sec] || 0;
        if (have === 0) continue;
        const arrName = RA.fields.ARRAY_NAME_BY_SECTION[sec];
        const want = Array.isArray(profile[arrName]) ? profile[arrName].length : 0;
        const missing = want - have;
        if (missing > deficit) {
          deficit = missing;
          target = sec;
        }
      }

      if (!target) break;

      const btn = findAddButtonFor(target, descriptors);
      if (!btn) {
        limited = true;
        break;
      }

      // 点完「添加」整个列表常常会被销毁重建，所以下面只数控件个数，
      // 不重新做全文档扫描——每 30ms 扫一次整个 document 是不可接受的。
      const anchor = descriptors.find((d) => d.section && d.section.key === target);
      const scope = (anchor && (anchor.section.rootEl || anchor.el.parentElement)) ||
        btn.parentElement || document.body;
      const countControls = () => scope.querySelectorAll('input:not([type=hidden]),select,textarea').length;
      const beforeCount = countControls();

      try {
        btn.click();
      } catch (e) {
        limited = true;
        break;
      }

      const ok = await RA.fill.waitFor(() => {
        if (!scope.isConnected) return 'detached';
        return countControls() > beforeCount ? true : null;
      }, 1500, 120);

      if (!ok) {
        limited = true;
        break;
      }
      added++;
    }

    return { added, limited };
  }

  // ─────────────────────── 填充 ───────────────────────

  function dumpDebug(descriptors, matches) {
    const keyOf = new Map(matches.map((m) => [m.d.el, m]));
    console.group('[简历填写] 候选字段信号表');
    console.table(descriptors.filter((d) => !d.consumed).map((d) => {
      const m = keyOf.get(d.el);
      return {
        标签: d.signals.labelText,
        来源: d.signals.labelSource,
        name: d.signals.name,
        placeholder: d.signals.placeholder,
        类型: d.signals.inputType,
        区块: d.section.key || '',
        条目: d.section.entryIndex ?? '',
        匹配: m ? m.key : '',
        分数: m ? m.score.toFixed(2) : '',
      };
    }));
    console.groupEnd();
  }

  /**
   * 按匹配结果逐个写入。
   * 返回 { rows, stats, usedEls } —— usedEls 用来判断哪些控件没被认出来。
   */
  // 省 → 市 → 区：很多站点是三级联动，后一级的选项要等前一级选中之后才会出现
  const REGION_ORDER = ['basic.addressProvince', 'basic.city', 'basic.addressDistrict'];
  const REGION_RANK = { [REGION_ORDER[0]]: 0, [REGION_ORDER[1]]: 1, [REGION_ORDER[2]]: 2 };

  function regionPathOf(profile) {
    const b = (profile && profile.basic) || {};
    return [b.addressProvince, b.city, b.addressDistrict]
      .map((v) => (v == null ? '' : String(v).trim()));
  }

  async function fillMatches(matches, profile, settings) {
    const rows = [];
    const stats = { high: 0, low: 0, fail: 0, skip: 0 };
    const usedEls = new Set();
    const regionPath = regionPathOf(profile);

    // 三级联动的下拉必须按 省 → 市 → 区 的顺序写：后一级的选项靠前一级触发生成，
    // 顺序反了就会「没有匹配选项」。
    matches.sort((a, b) => {
      const ra = REGION_RANK[a.key];
      const rb = REGION_RANK[b.key];
      if (ra == null && rb == null) return 0;
      if (ra == null) return 1;
      if (rb == null) return -1;
      return ra - rb;
    });

    let sawRegion = false;

    for (const m of matches) {
      const d = m.d;
      usedEls.add(d.el);
      // 填充器靠这两个信息判断「这是日期」「这是省市区级联」
      d.raKey = m.key;

      const isRegion = REGION_RANK[m.key] != null;
      if (isRegion && regionPath.filter(Boolean).length >= 2) {
        d.regionPath = regionPath;
      }

      // 上一级刚写完，等这一级的选项刷新出来再动手
      if (isRegion && sawRegion && d.kind === 'select') {
        try {
          await RA.fill.waitFor(() => d.el.options.length > 1, 1500);
        } catch (e) { /* 等不到就照常写，交给回读复查兜底 */ }
      }

      const entryIndex = (d.section && d.section.entryIndex) || 0;
      const raw = RA.fill.valueFor(profile, m.key, entryIndex);
      const def = RA.fields.BY_KEY[m.key];
      const label = def ? def.label : m.key;

      // 空字符串也得跳过：valueVariants 会返回空数组，
      // 落到日期控件那条分支上就会对 undefined 取 slice
      if (raw == null || String(raw).trim() === '') { stats.skip++; continue; }
      if (m.tier === 'skip') { stats.skip++; continue; }
      if (m.tier === 'low' && settings.lowConfidence === 'skip') { stats.skip++; continue; }

      const variants = RA.fill.valueVariants(m.key, raw);
      let res;
      try {
        res = await RA.fill.writeOne(d, variants, raw);
      } catch (e) {
        res = { ok: false, reason: 'exception: ' + (e && e.message) };
      }

      // 诊断报告要看到「每个字段试了什么、为什么失败」，比结果面板多一层细节
      try {
        if (RA.diag) {
          RA.diag.recordAttempt({
            d, key: m.key, label, tier: m.tier, score: m.score, raw, variants,
            ok: res.ok, reason: res.reason, via: res.via, actual: res.actual,
            panel: res.panel,
          });
        }
      } catch (e) { /* 诊断失败不能影响填充 */ }

      if (res.ok) {
        if (m.tier === 'high') stats.high++;
        else stats.low++;
        RA.overlay.markField(d.el, m.tier);
        rows.push({ label, value: String(raw), tier: m.tier,
          note: m.tier === 'low' ? '分数 ' + m.score.toFixed(2) : '' });
      } else {
        stats.fail++;
        rows.push({ label, value: String(raw), tier: 'fail', note: res.reason || '写入失败' });
      }

      if (isRegion) {
        sawRegion = true;
        await RA.fill.sleep(180); // 给联动一点时间，再写下一级
      }
    }

    return { rows, stats, usedEls };
  }

  function mergeAndRender(extraRows, extraStats) {
    sessionRows.push(...extraRows);
    sessionStats.high += extraStats.high || 0;
    sessionStats.low += extraStats.low || 0;
    sessionStats.fail += extraStats.fail || 0;
    sessionStats.skip += extraStats.skip || 0;
    if (extraStats.unfilled != null) sessionStats.unfilled = extraStats.unfilled;
    RA.overlay.showPanel(sessionRows, sessionStats);
  }

  /** 整页自动填充 */
  async function doFill(settings) {
    const profile = await RA.storage.getProfile();
    if (!profile) return { ok: false, reason: 'no-profile', found: 0 };

    const diag = RA.diag && typeof RA.diag.begin === 'function' ? RA.diag : null;

    RA.overlay.clearMarks();
    resetSession();
    if (diag) diag.begin();

    const entryInfo = await ensureEntries(profile, settings);

    // 经历条目可能已经变了，重新做一次完整分析
    const descriptors = freshScan(document);
    const matches = RA.score.match(descriptors);

    if (diag) diag.setScan(descriptors, matches);

    if (settings.debug) dumpDebug(descriptors, matches);

    if (!matches.length) {
      // 一个都没匹配上时也要给结果面板：诊断按钮是这种情况唯一的排查入口。
      // 但只在「像简历页」的 frame 里弹——否则页面上的广告 iframe 也会各弹一个。
      if (diag) diag.setUnfilled(descriptors.map((d) => d.el));
      let showPanel = false;
      try { showPanel = looksLikeResumePage(); } catch (e) { showPanel = false; }
      if (showPanel) {
        RA.overlay.showPanel([], { high: 0, low: 0, fail: 0, unfilled: descriptors.length },
          '没找到可填字段');
      }
      return { ok: false, reason: 'no-fields', found: 0 };
    }

    const { rows, stats, usedEls } = await fillMatches(matches, profile, settings);

    // 没被识别出来的控件用虚线标出来，引导用户手动指定
    unfilledEls = descriptors
      .filter((d) => !d.consumed && !usedEls.has(d.el))
      .map((d) => d.el);
    stats.unfilled = unfilledEls.length;
    if (diag) diag.setUnfilled(unfilledEls);
    RA.overlay.markUnfilled(unfilledEls);

    if (entryInfo.limited) {
      rows.push({ label: '经历条目', value: '页面上没有空间放下全部经历，已尽力填入前几条',
        tier: 'low', note: '需手动补' });
    }

    mergeAndRender(rows, stats);

    return {
      ok: true, found: matches.length, ...stats, added: entryInfo.added,
      preview: rows.slice(0, 12),
    };
  }

  /**
   * 用户指定了某个输入框对应简历里的哪个字段。
   * @param {Element} node
   * @param {string} key
   * @param {number} entryIndex
   * @param {{quiet?:boolean}} [opts] quiet=true 时只返回值，不弹提示也不开结果面板
   *        （数据面板自己会给反馈，两个面板同时冒出来太吵）
   */
  async function fillField(node, key, entryIndex, opts = {}) {
    const quiet = !!opts.quiet;
    const profile = await RA.storage.getProfile();
    if (!profile) {
      if (!quiet) RA.overlay.showToast('还没有填写简历数据');
      return { ok: false, reason: 'no-profile' };
    }

    const raw = RA.fill.valueFor(profile, key, entryIndex || 0);
    const def = RA.fields.BY_KEY[key];
    const label = def ? def.label : key;

    if (raw == null || String(raw).trim() === '') {
      if (!quiet) RA.overlay.showToast(`简历里「${label}」是空的，没有内容可填`);
      return { ok: false, reason: 'no-value' };
    }

    // 找这个控件对应的描述符；扫不到就现造一个
    let d = null;
    try {
      const descriptors = freshScan(document);
      d = descriptors.find((x) => x.el === node || (x.els && x.els.includes(node)));
    } catch (e) { /* 忽略，下面兜底 */ }

    if (!d) {
      let signals;
      try {
        signals = RA.scan.collectSignals(node);
      } catch (e) {
        RA.overlay.showToast('这个控件填不了');
        return { ok: false, reason: 'not-fillable' };
      }
      d = { el: node, els: [node], kind: RA.scan.kindOf(node), domIndex: 0, signals };
    }

    // 填充器靠这两个信息判断「这是日期」「这是省市区级联」
    d.raKey = key;
    if (REGION_RANK[key] != null) d.regionPath = regionPathOf(profile);

    const variants = RA.fill.valueVariants(key, raw);
    let res;
    try {
      res = await RA.fill.writeOne(d, variants, raw);
    } catch (e) {
      res = { ok: false, reason: 'exception: ' + (e && e.message) };
    }

    try {
      if (RA.diag) {
        RA.diag.recordAttempt({
          d, key, label, tier: 'manual', score: null, raw, variants,
          ok: res.ok, reason: res.reason, via: res.via, actual: res.actual,
          panel: res.panel, manual: true,
        });
      }
    } catch (e) { /* 诊断失败不能影响填充 */ }

    if (res.ok) {
      RA.overlay.markField(node, 'high');
      if (!quiet) {
        RA.overlay.showToast(`已填入「${label}」：${String(raw).slice(0, 30)}`);
        mergeAndRender([{ label, value: String(raw), tier: 'high', note: '手动指定' }],
          { high: 1, low: 0, fail: 0, skip: 0 });
      }
    } else if (!quiet) {
      RA.overlay.showToast(`写入失败（${res.reason || '未知原因'}）`);
      mergeAndRender([{ label, value: String(raw), tier: 'fail', note: res.reason || '写入失败' }],
        { high: 0, low: 0, fail: 1, skip: 0 });
    }

    return { ok: !!res.ok, reason: res.reason, value: String(raw) };
  }

  // ─────────────────────── 只扫描不填充 ───────────────────────

  function doScanOnly() {
    const descriptors = RA.scan.collectFields(document);
    RA.section.annotate(descriptors);
    const matches = RA.score.match(descriptors);

    // 预览也是一次完整的「扩展怎么看这个页面」，同样值得能复制出来。
    // 注意不要 begin()：popup 每次打开都可能触发扫描，不能把上一轮填写的
    // 失败记录冲掉，否则「复制诊断」就只剩扫描结果了。
    if (RA.diag && typeof RA.diag.setScan === 'function') {
      RA.diag.setScan(descriptors, matches);
      RA.diag.setUnfilled(descriptors.filter((d) => !matches.some((m) => m.d === d)).map((d) => d.el));
    }

    return {
      ok: true,
      found: matches.length,
      fields: descriptors.filter((d) => !d.consumed).length,
      preview: matches.slice(0, 20).map((m) => {
        const def = RA.fields.BY_KEY[m.key];
        return {
          label: def ? def.label : m.key,
          value: m.d.signals.labelText || m.d.signals.placeholder || m.d.signals.name,
          tier: m.tier,
          note: m.score.toFixed(2),
        };
      }),
    };
  }

  // ─────────────────────── 主题 ───────────────────────

  let systemThemeWatched = false;

  /** 系统深浅色变化时重新解析（只在「跟随系统」模式下有意义） */
  function watchSystemTheme(enabled) {
    if (!enabled || systemThemeWatched) return;
    try {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        RA.overlay.applyTheme('auto');
      });
      systemThemeWatched = true;
    } catch (e) { /* 环境不支持就算了 */ }
  }

  async function syncTheme() {
    try {
      const s = await RA.storage.getSettings();
      RA.overlay.applyTheme(s.theme);
      watchSystemTheme(s.theme === 'auto');
    } catch (e) { /* 忽略，按浅色兜底 */ }
  }

  // 用户在选项页改了主题，已经打开的页面立刻跟着变
  try {
    const store = root.chrome && root.chrome.storage;
    if (store && store.onChanged) {
      store.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        const ch = changes[RA.storage.K_SETTINGS];
        if (ch) {
          const next = ch.newValue || {};
          RA.overlay.applyTheme(next.theme || 'auto');
          watchSystemTheme(next.theme === 'auto');
        }

        // 数据是跟着模板走的：切换模板等于换一份数据，
        // 已经打开的面板要重新读一遍，否则还停在旧模板的内容上
        // 模板或当前简历变了，打开着的数据面板要重新读一遍
        if (changes[RA.storage.K_TEMPLATES] || changes[RA.storage.K_RESUMES]) {
          try { RA.datapanel.refresh().catch(() => {}); } catch (e) { /* 忽略 */ }
        }
      });
    }
  } catch (e) { /* 忽略 */ }

  syncTheme();

  // 顶层文档挂一个左下角的悬浮入口：点一下直接开数据面板，
  // 不用先点扩展图标再点里面的按钮。
  // iframe 里不挂 —— all_frames 让这份脚本在每个 frame 都跑，
  // 不判断的话一层嵌套页面就会冒出好几个按钮。
  // 悬浮按钮点开的是「首页卡片」——和点扩展图标看到的是同一套入口，
  // 而不是直接跳到数据面板。
  const homeActions = {
    onPanel: () => RA.datapanel.open(),

    onFill: async () => {
      // 和消息路由共用同一个重入锁，避免和 popup 同时触发
      if (running) { RA.overlay.showToast('正在填充，请稍等'); return; }
      running = true;
      try {
        const settings = await RA.storage.getSettings();
        RA.debug = !!settings.debug;
        const r = await doFill(settings);
        if (r && !r.ok) {
          RA.overlay.showToast(
            r.reason === 'no-profile' ? '还没有填写简历数据'
              : r.reason === 'no-fields'
                ? '这一层没找到表单；若表单在 iframe 里，请用扩展图标填充'
                : '没有可填的内容'
          );
        }
      } finally {
        running = false;
      }
    },

    onPreview: () => {
      const r = doScanOnly();
      if (!r.found) {
        RA.overlay.showToast('页面上没有找到可识别的表单字段');
        return;
      }
      const stats = { high: 0, low: 0, fail: 0, unfilled: 0 };
      for (const m of r.preview) {
        if (m.tier === 'high') stats.high++; else stats.low++;
      }
      RA.overlay.showPanel(
        r.preview.map((m) => ({
          label: m.label,
          value: m.value ? String(m.value) : '（无标签）',
          tier: m.tier,
          note: m.note,
        })),
        stats,
        '匹配预览（未写入）'
      );
    },

    // 内容脚本拿不到 openOptionsPage，交给后台代劳
    onOptions: () => {
      try {
        root.chrome.runtime.sendMessage({ type: 'RA_OPEN_OPTIONS' });
      } catch (e) { /* 忽略 */ }
    },
  };

  // ─────────────────────── 悬浮按钮的出现条件 ───────────────────────

  /** 页面标题 / 链接里出现这些词，基本可以确定是招聘页 */
  const RESUME_WORDS = /简历|网申|应聘|求职|投递|职位申请|申请职位|校园招聘|社会招聘|招聘|个人资料|resume|curriculum|apply|application|job/i;

  /** 表单字段名里出现这些词，说明像在填个人信息 */
  const FIELD_WORDS = /姓名|手机|电话|邮箱|邮件|学校|毕业|学历|专业|工作经历|教育经历|项目经历|实习|自我评价|出生|性别|身份证|期望职位|求职意向|应聘职位/;

  const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password']);

  /**
   * 这个页面像不像「网申 / 简历填写」页。
   *
   * 纯规则，快速判断：先看有没有足够的输入框，再看标题和字段名里的关键词。
   * 宁可漏判也不误判——漏了还能点扩展图标，误了就是每个网站都挂个按钮。
   */
  function looksLikeResumePage() {
    let n = 0;
    let hint = 0;

    const els = document.querySelectorAll('input, select, textarea');
    for (const el of els) {
      if (n >= 400) break; // 超大页面不再细看
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (SKIP_INPUT_TYPES.has(type)) continue;
      n++;

      const sig = [
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('name'),
        el.getAttribute('id'),
      ].join(' ');
      if (FIELD_WORDS.test(sig)) hint++;
    }

    if (n < 3) return false;

    const titleSig = document.title + ' ' + location.href;
    if (RESUME_WORDS.test(titleSig)) return true;

    for (const h of document.querySelectorAll('h1, h2, h3')) {
      if (RESUME_WORDS.test(h.textContent || '')) return true;
    }

    // 带密码框又没有招聘信号 → 大概率是登录 / 注册页
    if (document.querySelector('input[type="password"]')) return false;

    // 简历文件上传框是很强的信号
    const upload = document.querySelector(
      'input[type="file"][accept*="pdf"], input[type="file"][accept*="doc"], input[type="file"][accept*="word"]'
    );
    if (upload && hint >= 1) return true;

    // 字段名命中三个以上，且表单至少有五个框
    return hint >= 3 && n >= 5;
  }

  /**
   * 单页应用的表单经常是后渲染出来的，所以头 30 秒里盯着 DOM 变化再判断几次。
   * 一旦显示就固定住，不因为页面后续变化把按钮收回去。
   */
  function watchForResumeForm() {
    let shown = false;
    let timer = null;
    let observer = null;
    const deadline = Date.now() + 30000;

    const stop = () => {
      if (observer) { observer.disconnect(); observer = null; }
      if (timer) { clearTimeout(timer); timer = null; }
    };

    const check = () => {
      if (shown) return;
      try {
        if (looksLikeResumePage()) {
          shown = true;
          RA.overlay.showFab(() => RA.overlay.toggleHome(homeActions));
          stop();
          return;
        }
      } catch (e) { /* 判断出错就当不是 */ }

      if (Date.now() > deadline) stop();
    };

    check();
    if (shown) return;

    try {
      observer = new MutationObserver(() => {
        if (timer) return;
        timer = setTimeout(() => { timer = null; check(); }, 700);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* 没有 MutationObserver 就只判断这一次 */ }
  }

  try {
    // root.top 存在 = 在浏览器窗口里；等于 self = 是顶层文档
    // （Node 测试环境里没有 top，这里自然为假）
    if (root.top && root.top === root.self) watchForResumeForm();
  } catch (e) { /* 拿不到 top 就算了，宁可没有按钮 */ }

  // ─────────────────────── 消息路由 ───────────────────────

  let running = false;

  root.chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'RA_PING') {
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'RA_SCAN') {
      let res;
      try {
        res = doScanOnly();
      } catch (e) {
        res = { ok: false, reason: String(e && e.message) };
      }
      // 没扫到字段就不应答，让真正有表单的那一帧来回话
      if (!res.found) return;
      sendResponse(res);
      return;
    }

    if (msg.type === 'RA_FILL') {
      if (running) { sendResponse({ ok: false, reason: 'busy' }); return true; }
      running = true;
      (async () => {
        try {
          const settings = await RA.storage.getSettings();
          RA.debug = !!settings.debug;
          sendResponse(await doFill(settings));
        } catch (e) {
          sendResponse({ ok: false, reason: String(e && e.message) });
        } finally {
          running = false;
        }
      })();
      return true; // 异步应答
    }

    if (msg.type === 'RA_DATAPANEL') {
      Promise.resolve()
        .then(() => RA.datapanel.toggle())
        .then((r) => sendResponse({ ok: true, open: !!(r && r.open), reason: r && r.reason }))
        .catch((e) => sendResponse({ ok: false, reason: String(e && e.message) }));
      return true;
    }

    if (msg.type === 'RA_UNDO') {
      const n = RA.fill.undoAll();
      RA.overlay.teardown();
      resetSession();
      sendResponse({ ok: true, undone: n });
      return;
    }
  });

  RA.main = {
    freshScan,
    doFill,
    doScanOnly,
    ensureEntries,
    fillField,
    looksLikeResumePage,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
