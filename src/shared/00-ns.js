/**
 * 全局命名空间。
 *
 * MV3 的 content script 不支持静态 import，但同一个 content_scripts 条目里
 * js[] 数组的多个文件共享同一个 isolated world 作用域，并按数组顺序执行。
 * 所以所有模块都挂在 globalThis.RA 上，由 manifest 控制加载顺序。
 *
 * 这个文件必须第一个加载。
 */
(function (root) {
  'use strict';

  const RA = root.RA || (root.RA = {});

  RA.version = '1.0.0';

  // 各模块的挂载点，预先建好，避免后续文件里到处写 `RA.x = RA.x || {}`
  RA.normalize = RA.normalize || {};
  RA.fields = RA.fields || {};
  RA.storage = RA.storage || {};
  RA.scan = RA.scan || {};
  RA.section = RA.section || {};
  RA.score = RA.score || {};
  RA.fill = RA.fill || {};
  RA.overlay = RA.overlay || {};
  RA.pick = RA.pick || {};
  RA.datapanel = RA.datapanel || {};

  /** 调试开关：在选项页里可以打开，打开后往 console 打候选信号表和映射表 */
  RA.debug = false;
})(typeof globalThis !== 'undefined' ? globalThis : window);
