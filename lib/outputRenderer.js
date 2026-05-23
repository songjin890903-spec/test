/**
 * 输出渲染器 - 即梦(Jimeng)友好版
 * 版本: v8.0-jimeng-friendly
 * 
 * 核心功能（纯格式编排，不硬编码任何内容！）：
 * 1. 清理内部对话标签
 * 2. 清理禁止项残留
 * 3. 最终格式整理
 */

/**
 * 清理内部对话标签
 */
function stripInternalDialogueTags(text) {
  let s = String(text || '');
  s = s.replace(/台词\s*\[D\d{3,}(?:-\d+)?\]\s*/g, '');
  s = s.replace(/\n【F】台词覆盖：[\s\S]*?(?=\n---\n|\n@[^\n]+\n\s*【片段|\s*$)/g, '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/**
 * 清理残留的禁止项描述
 */
function cleanRestrictedTerms(text) {
  let s = String(text || '');
  const templatePatterns = [
    /听者保持当前状态[^，,\n]*/g,
    /动作未完成[^，,\n]*/g,
    /环境声低底噪[^，,\n]*/g,
    /环境声保持低底噪[^，,\n]*/g,
    /无特殊声音[^，,\n]*/g,
    /暂无[^，,\n]*/g,
    /\(空\)/g,
    /\(无\)/g
  ];
  for (const pattern of templatePatterns) {
    s = s.replace(pattern, '');
  }
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/**
 * 清理内部调试信息
 */
function stripDebugInfo(text) {
  let s = String(text || '');
  s = s.replace(/\[DEBUG\][^\n]*\n*/g, '');
  s = s.replace(/【DEBUG】[^\n]*\n*/g, '');
  s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\n]*\n*/g, '');
  return s;
}

/**
 * 主渲染函数
 * @param {string} internalText - 内部文本
 * @param {object} options - 配置选项
 * @param {boolean} options.jimengMode - 是否启用即梦格式（默认假，保持兼容）
 */
function renderCleanCOutput(internalText, options = {}) {
  const { jimengMode = false } = options;
  let text = String(internalText || '');
  text = stripInternalDialogueTags(text);
  text = cleanRestrictedTerms(text);
  text = stripDebugInfo(text);
  return text;
}

module.exports = { 
  renderCleanCOutput,
  stripInternalDialogueTags
};
