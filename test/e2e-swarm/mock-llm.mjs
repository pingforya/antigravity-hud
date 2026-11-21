import http from 'node:http';

const TOKEN_RE = /⟦P\d+⟧/g;
const QUOTED_CJK_RE = /"[^"\n]*[\u4e00-\u9fff][^"\n]*"|“[^”\n]*[\u4e00-\u9fff][^”\n]*”/g;

const PHRASE_RULES = [
  // buildBasicSwarm & test phrases
  [/\bAll verification checks passed cleanly\b/gi, '所有验证检查已全部通过'],
  [/\bAll workstreams completed cleanly\b/gi, '所有工作流已顺利完成'],
  [/\bAll tests passed cleanly\b/gi, '所有测试已全部通过'],
  [/\bAudit and fix Hub window layouts\b/gi, '审查并修复 Hub 窗口布局'],
  [/\bCould you confirm the schema before I finalize\??/gi, '在我最终确认前能否核对一下数据结构？'],
  [/\bCould you approve this PR\??/gi, '能否批准此 PR？'],
  [/\bCan you verify this output\??/gi, '能否验证此输出？'],
  [/\bPlease inspect\b/gi, '请检查'],
  [/\bPlease run\b/gi, '请运行'],
  [/\bAll\s+(\d+)\s+research streams\b/gi, '全部 $1 条研究分支'],
  [/\bPhase\s*([0-9A-Za-z]+)\s+verification\s+complete\b/gi, '第 $1 阶段验证已完成'],
  [/\bverification\s+complete\b/gi, '验证已完成'],
  [/\bcompleted cleanly\b/gi, '已顺利完成'],
  [/\bTests passed\b/gi, '测试已通过'],
  [/\brun tests\b/gi, '运行测试'],
  [/\bRun checks\b/gi, '运行检查'],
  [/\bYou own\b/gi, '你负责'],
  [/\bWaiting for posts\b/gi, '正在等待看板消息'],
  [/\bReading the board\b/gi, '正在读取看板'],
  [/\bPosting to the board\b/gi, '正在向看板发送消息'],
  [/\bAuditing search filter behavior\b/gi, '正在审查搜索筛选逻辑'],
  [/\bBackend research\b/gi, '后端调研'],
  [/\bReviewing backend report\b/gi, '正在审阅后端报告'],
  [/\bRunning integration checks\b/gi, '正在运行集成检查'],
  [/\bUntitled swarm\b/gi, '未命名协作蜂群'],

  // buildRichOverviewSwarm & buildPlanAndChannelsSwarm
  [/\bDrafting a design doc; research done, draft under review\b/gi, '正在起草设计文档；调研已完成，草稿审阅中'],
  [/\bBackend is running integration checks while critic reviews layout\b/gi, '后端正在运行集成检查，同时评审员正在审阅布局'],
  [/\bFour fixes landed; split pane polish in review\b/gi, '四项修复已落地；分栏细节正在审阅中'],
  [/\bDecide: freeform HTML or JSON view model\??/gi, '决策：采用自由格式 HTML 还是 JSON 视图模型？'],
  [/\bcritic and designer disagree; blocks the final doc\b/gi, '评审员与设计师存在分歧，阻塞了最终文档'],
  [/\bCritic and designer disagree on final format\b/gi, '评审员与设计师对最终格式存在分歧'],
  [/\bHTML or JSON model\??/gi, 'HTML 还是 JSON 模型？'],
  [/\bJump to\b/gi, '跳转到'],
  [/\bHook point found in main process\b/gi, '已在主进程找到挂载点'],
  [/\bFound main-process hook; 2 of 5 checks done\b/gi, '已找到主进程挂载点；5 项检查已完成 2 项'],
  [/\bLayout review\b/gi, '布局审阅'],
  [/\bWaiting on format decision\b/gi, '等待格式决策'],
  [/\bSplit pane cards\b/gi, '分栏卡片'],
  [/\bPut split panes inside shared cards\b/gi, '将分栏放入共享卡片中'],
  [/\bPut split panes in one card\b/gi, '将分栏放入同一张卡片'],
  [/\bPanes share one card with clean headers\b/gi, '分栏共享同一张卡片并保持标题简洁'],
  [/\bFolding polish into the fix\b/gi, '正在将细节优化合并进修复方案'],
  [/\bBackend report posted\b/gi, '后端报告已发布'],
  [/\bAlways-on member adds token cost\b/gi, '常驻成员会增加令牌开销'],
  [/\bSwitched to a kanban, as you asked\b/gi, '已按你的要求切换为看板视图'],
  [/\bBaseline header before alignment\b/gi, '对齐前的基线页眉'],
  [/\bAligned split pane cards\b/gi, '对齐后的分栏卡片'],
  [/\bInvestigate the main process hook and report findings\b/gi, '排查主进程挂载点并汇报发现'],
  [/\bReview the proposed split pane layout\b/gi, '审阅拟议的分栏布局'],
  [/\bI disagree with freeform HTML; can you confirm JSON view model\??/gi, '我不同意自由格式 HTML，能否确认使用 JSON 视图模型？'],
  [/\bIntegration checks 2 of 5 completed\b/gi, '集成检查已完成 2/5'],
  [/\bContinue checking remaining integration cases\b/gi, '继续检查剩余的集成用例'],
  [/\bImplement AST parser module\b/gi, '实现 AST 解析器模块'],
  [/\bAST ready for review\b/gi, '抽象语法树（AST）已就绪待审阅'],
  [/\bPosting to archived channel and main summary\b/gi, '正在向已归档频道和主汇总发送消息'],
  [/\bFix Hub split pane layouts\b/gi, '修复 Hub 分栏布局'],
  [/\bAudit, fix, then verify in both themes\b/gi, '在两种主题下审查、修复并验证'],
  [/\bAudit split panes across states\b/gi, '跨状态审查分栏'],
  [/\bHub Window Layout Audit\b/gi, 'Hub 窗口布局审查'],
  [/\bParser & Channel Plan Swarm\b/gi, '解析器与频道计划蜂群'],

  // Tier 1/2/3/4 test fixture sentences
  [/\bAsync translation arrival check\b/gi, '异步翻译到达检查'],
  [/\bRetry after rate limit check\b/gi, '限流退避重试检查'],
  [/\bFirst hung message\b/gi, '首条挂起消息'],
  [/\bSecond message processed by free worker\b/gi, '第二条消息已由空闲工作线程处理'],
  [/\bNewly appended live report verified successfully\b/gi, '新追加的实时报告已成功验证'],
  [/\bExternal status report submitted\b/gi, '外部状态报告已提交'],
  [/\bUnique worker task item number (\d+) requires validation\b/gi, '唯一工作任务项编号 $1 需要验证'],
  [/\bInspect swarm\b/gi, '立即检查协作蜂群'],
  [/\bSanitize\b/gi, '请安全清理'],
  [/\bproperly\b/gi, '妥善处理'],
  [/\bSee specification at\b/gi, '请查看规范'],
  [/\bbefore merging\b/gi, '于合并前'],
  [/\bCheck\b/gi, '检查'],
  [/\bafter retry\b/gi, '在重试后'],
  [/\bCompare\b/gi, '对比'],
  [/\bWaiting on schema approval\b/gi, '等待数据结构批准'],
  [/\bNo progress for (\d+m)\b/gi, '$1 无进展'],
  [/\bRate limit exhausted\b/gi, '请求配额已耗尽'],
  [/\bUnrelated log note without target keyword\b/gi, '不含目标关键词的无关日志记录'],
  [/\bSwarm finished cleanly\b/gi, '协作蜂群已顺利完成'],
  [/\baudit passed\b/gi, '审查已通过'],
  [/\bCapture before and after UI screenshots\b/gi, '捕获界面修改前后的截图'],
  [/\bFirst screenshot ready\b/gi, '首张截图已就绪'],
  [/\bFixed layout\b/gi, '已修复布局'],
  [/\bAttention everyone: sync now\b/gi, '全体注意：立即同步状态'],
  [/\bLong run finished\b/gi, '长耗时任务已完成'],
  [/\bStart long run\b/gi, '启动长耗时任务'],
  [/\bStart audit\b/gi, '开始审查'],
  [/\bExecute diagnostics\b/gi, '执行诊断检查'],
  [/\bStarting diagnostics pass\b/gi, '正在启动诊断流程'],
  [/\bimmediately\b/gi, '立即'],
  [/\bverified\b/gi, '已验证'],

  // 56f8c44e #36-#42 phrases
  [/\bfinal verification pass\b/gi, '最终验证流程'],
  [/\bSpot-check directly against raw\b/gi, '直接对照原始文件抽检'],
  [/\bwith a concise verification script under\b/gi, '使用简洁的验证脚本于'],
  [/\bArithmetic & Aggregation Audit\b/gi, '算术与汇总核查'],
  [/\bIndependently recompute all aggregate totals from\b/gi, '独立重新计算全部汇总数据自'],
  [/\bmatches the JSON with 0 arithmetic discrepancies\b/gi, '与 JSON 完全一致且无算术误差'],
  [/\bRaw Transcript Spot-Check of All 6 Standout Smoking Guns\b/gi, '6 项典型实锤问题的原始日志抽检'],
  [/\bStandout Smoking Guns Verified Verbatim on Raw Disk\b/gi, '原始磁盘上逐字核验的典型实锤问题'],
  [/\bHeadline findings\b/gi, '核心结论'],
  [/\bCLEAN PASS\b/gi, '完全通过'],
  [/\bArithmetic Match\b/gi, '算术一致'],
  [/\bMaterial Defects\b/gi, '实质性缺陷'],
  [/\bTiny Polish Notes \(Non-Blocking\)\b/gi, '细微润色建议（非阻塞）'],
  [/\bRaw Transcript Spot-Checks\b/gi, '原始日志抽检'],
  [/\bAll 4 research streams\b/gi, '全部 4 条调研分支'],
  [/\band all 3 adversarial verification passes\b/gi, '以及全部 3 轮对抗验证'],
  [/\bfinal verified report published to\b/gi, '最终已验证报告已发布至'],
  [/\bPASS \/ PARTIAL \/ FAIL table\b/gi, '通过 / 部分通过 / 失败 对照表'],
  [/\bwhen finished\b/gi, '完成后'],
  [/\bYou own the corpus & origin inventory answering WHY the user has\b/gi, '你负责语料与来源盘点，解释用户为何拥有'],
  [/\bYou own the parent-child lineage tree, timeline, top spawners, UI-vs-disk retention behavior, and disk footprint analysis\b/gi, '你负责父子谱系树、时间线、高频派生源、UI 与磁盘保留行为及磁盘占用分析'],
  [/\bYou are the independent verifier for the\b/gi, '你是本次专项调查的独立验证者'],
  [/\bStrictly READ-ONLY on all Antigravity data and NEVER modify\b/gi, '对所有 Antigravity 数据保持严格只读，绝不修改'],
  [/\bwrite your outputs ONLY to\b/gi, '仅将输出写入'],
  [/\bwrite your verification report ONLY to\b/gi, '仅将验证报告写入'],
  [/\bReconcile exact counts across ALL local sources\b/gi, '对所有本地数据源的精确数量进行对账'],
  [/\bClassify EVERY Antigravity conversation\b/gi, '对每条 Antigravity 会话进行分类'],
  [/\bDistinguish clearly\b/gi, '清晰区分'],
  [/\bInclude sample titles\/first lines\b/gi, '包含示例标题与首行内容'],
  [/\bBuild the exact\b/gi, '构建精确的'],
  [/\bIdentify the\b/gi, '识别出'],
  [/\bBuild a chronological timeline\b/gi, '构建按时间顺序的时间线'],
  [/\bMeasure exact disk footprint\b/gi, '精确统计磁盘占用空间'],
  [/\bCheck whether there are any\b/gi, '检查是否存在任何'],
  [/\bWait for both\b/gi, '等待双方'],
  [/\bOnce BOTH have posted\b/gi, '一旦双方均已发布'],
  [/\bIndependently cross-check EVERY headline number directly against raw disk\b/gi, '直接对照原始磁盘独立交叉核验每一项核心数字'],
  [/\bIf you find any discrepancy or arithmetic error\b/gi, '若发现任何差异或算术错误'],
  [/\bOnce all numbers reconcile cleanly\b/gi, '待所有数字对账一致后'],
  [/\bWhen done, post\b/gi, '完成后请发布'],
  [/\bready for\b/gi, '已就绪待'],
  [/\bif needed\b/gi, '如需'],
];

const WORD_GLOSSARY = {
  a: '',
  an: '',
  the: '',
  and: '与',
  or: '或',
  of: '的',
  in: '在',
  on: '在',
  at: '于',
  to: '至',
  for: '用于',
  from: '来自',
  with: '配合',
  by: '由',
  via: '通过',
  against: '对照',
  across: '跨',
  under: '在…下',
  between: '在…之间',
  before: '之前',
  after: '之后',
  when: '当',
  while: '同时',
  once: '一旦',
  both: '双方',
  all: '全部',
  each: '每项',
  every: '每个',
  any: '任何',
  no: '无',
  not: '不',
  only: '仅',
  never: '绝不',
  also: '同时',
  now: '当前',
  then: '然后',
  about: '关于',
  into: '进入',
  that: '该',
  this: '此',
  are: '为',
  is: '是',
  was: '为',
  were: '为',
  have: '有',
  has: '拥有',
  had: '曾有',
  will: '将',
  can: '可',
  must: '必须',
  should: '应当',
  need: '需要',
  needed: '需要',
  needs: '需要',
  run: '运行',
  running: '运行中',
  check: '检查',
  checks: '检查项',
  checked: '已检查',
  verify: '验证',
  verified: '已验证',
  verification: '验证',
  audit: '审查',
  audited: '已审查',
  report: '报告',
  reports: '报告',
  table: '表格',
  line: '行',
  lines: '行',
  file: '文件',
  files: '文件',
  disk: '磁盘',
  raw: '原始',
  read: '读取',
  write: '写入',
  post: '发布',
  posted: '已发布',
  send: '发送',
  sent: '已发送',
  wait: '等待',
  waiting: '等待中',
  done: '已完成',
  pass: '通过',
  passed: '已通过',
  fail: '失败',
  failed: '已失败',
  partial: '部分通过',
  error: '错误',
  errors: '错误',
  discrepancy: '差异',
  discrepancies: '差异',
  arithmetic: '算术',
  count: '计数',
  counts: '计数',
  total: '总计',
  totals: '合计',
  exact: '精确',
  all_caps_pass: '通过',
  headline: '摘要',
  findings: '发现',
  summary: '总结',
  case: '案例',
  cases: '案例',
  event: '事件',
  events: '事件',
  active: '活跃',
  archived: '已归档',
  hidden: '隐藏',
  visible: '可见',
  child: '子',
  children: '子会话',
  parent: '父',
  conversation: '会话',
  conversations: '会话',
  chat: '聊天',
  chats: '聊天',
  user: '用户',
  agent: '智能体',
  subagent: '子智能体',
  subagents: '子智能体',
  worker: '执行者',
  workers: '执行者',
  coordinator: '协调者',
  browser: '浏览器',
  swarm: '协作蜂群',
  teamwork: '团队协作',
  local: '本地',
  source: '来源',
  sources: '数据源',
  category: '分类',
  categories: '分类',
  mutually: '互斥',
  exclusive: '排他',
  totaling: '总计',
  sidebar: '侧边栏',
  timeline: '时间线',
  footprint: '占用空间',
  retention: '保留策略',
  spawners: '派生源',
  spawned: '派生',
  spawning: '派生',
  direct: '直接',
  transitive: '传递',
  chronological: '按时间顺序',
  date: '日期',
  week: '周',
  burst: '集中爆发',
  days: '天',
  daily: '日常',
  usage: '使用',
  span: '跨度',
  oldest: '最早',
  newest: '最新',
  measure: '统计',
  share: '占比',
  whether: '是否',
  deleting: '删除',
  archiving: '归档',
  leaves: '遗留',
  orphan: '孤立',
  folders: '目录',
  persist: '持久保留',
  forever: '永久',
  surprise: '意外',
  probes: '探测',
  runs: '运行',
  aborted: '中止',
  empty: '空',
  missing: '缺失',
  overlap: '重叠',
  mismatch: '不匹配',
  misclassification: '误分类',
  confirm: '确认',
  clean: '干净',
  cleanly: '顺利',
  number: '数字',
  numbers: '数字',
  quote: '引用',
  sample: '样本',
  samples: '样本',
  titles: '标题',
  redacting: '脱敏',
  secrets: '敏感信息',
  created: '创建',
  actually: '实际',
  still: '仍然',
  get: '获得',
  own: '自身',
  entry: '条目',
  notes: '备注',
  note: '说明',
  polish: '润色',
  blocking: '阻塞',
  material: '实质性',
  defects: '缺陷',
  groups: '分组',
  smooth: '顺畅',
  costly: '高成本',
  hunting: '检索',
  redundant: '冗余',
  repeated: '重复',
  mistakes: '错误',
  forgetting: '遗忘',
  strict: '严格',
  recomputed: '重新计算',
  independently: '独立地',
  independent: '独立',
  verifier: '验证者',
  research: '调研',
  streams: '分支',
  adversarial: '对抗性',
  passes: '轮次',
  published: '已发布',
  complete: '完成',
  completed: '已完成',
  review: '审阅',
  reviewed: '已审阅',
  test: '测试',
  tests: '测试',
  fix: '修复',
  fixes: '修复项',
  fixed: '已修复',
  layout: '布局',
  layouts: '布局',
  explain: '解释',
  explaining: '解释',
  answer: '回答',
  answering: '回答',
  why: '为何',
  how: '如何',
  many: '多少',
  top: '顶部',
  heavy: '重度',
  multiply: '倍增',
  multiplying: '倍增',
  handful: '少数',
  today: '今日',
  session: '会话',
  including: '包括',
  data: '数据',
  config: '配置',
  modify: '修改',
  first: '首次',
  second: '第二',
  last: '最后',
  next: '下一项',
  remaining: '剩余',
  other: '其他',
  new: '新',
  old: '旧',
  full: '完整',
  concise: '简洁',
  script: '脚本',
  scripts: '脚本',
  using: '使用',
  investigate: '调查',
  investigation: '调查',
  reconcile: '对账',
  reconciled: '已对账',
  classify: '分类',
  distinguish: '区分',
  clearly: '清晰地',
  include: '包含',
  build: '构建',
  identify: '识别',
  shown: '显示',
  show: '显示',
  cross: '交叉',
  item: '条目',
  items: '条目',
  list: '列表',
  back: '退回',
  name: '名称',
  executive: '执行',
  crisp: '简明',
  path: '路径',
  paths: '路径',
  status: '状态',
  text: '文本',
  body: '正文',
  message: '消息',
  messages: '消息',
  main: '主',
  general: '通用',
  desktop: '桌面端',
  human: '用户',
  scheduled: '定时',
  automation: '自动化',
  voice: '语音',
  system: '系统',
  generated: '生成',
  bucket: '分组',
  recognize: '识别',
  immediately: '立即',
  outside: '外部',
  inside: '内部',
  step: '步骤',
  steps: '步骤',
  call: '调用',
  calls: '调用',
  stale: '陈旧',
  image: '图像',
  rollback: '回滚',
  safety: '安全',
  filter: '筛选',
  block: '拦截',
  eviction: '驱逐',
  killing: '终止',
  writes: '写入',
  ratio: '比例',
  paradox: '悖论',
  summary_cap: '摘要',
  loss: '丢失',
  lossless: '无损',
  lossy: '有损',
  warm: '热',
  cold: '冷',
  log: '日志',
  logs: '日志',
  manual: '手动',
  auto: '自动',
  trigger: '触发',
  regime: '机制',
  generation: '代际',
  impairment: '损伤',
  behavioral: '行为',
  spot: '抽样',
  verbatim: '逐字',
  absent: '缺失',
  reported: '报告',
  earlier: '此前',
  higher: '更高',
  scans: '扫描',
  current: '当前',
  delta: '增量',
  explain_delta: '说明差异',
  directory: '目录',
  dirs: '目录',
  artifact: '产物',
  turn: '轮次',
  zero: '零',
  steady: '稳定',
  phase: '阶段',
  positive: '正向',
  counter: '反例',
  proofs: '证明',
  proof: '证明',
  standout: '突出',
  smoking: '实锤',
  guns: '证据',
  mini: '简明',
  matching: '匹配',
  match: '匹配',
  zero_diff: '零差异',
};

const PRESERVE_ACRONYMS = new Set([
  'API', 'AST', 'CASS', 'CLI', 'CSS', 'DB', 'DOM', 'E2E', 'GC', 'HTML', 'HTTP', 'HTTPS',
  'ID', 'IDE', 'JD', 'JSON', 'JSONL', 'KB', 'KV', 'LLM', 'MB', 'MiB', 'KiB', 'OS',
  'PID', 'PR', 'SDK', 'SQL', 'SSE', 'UI', 'URL', 'UTF', 'UUID', 'XML',
]);

function translateRemainingEnglishWords(str) {
  return str.replace(/\b([A-Za-z][A-Za-z0-9'-]{2,})\b/g, (word) => {
    if (PRESERVE_ACRONYMS.has(word)) return word;
    const lower = word.toLowerCase();
    if (Object.hasOwn(WORD_GLOSSARY, lower)) {
      return WORD_GLOSSARY[lower];
    }
    return `术语[${word}]`;
  });
}

function translateLineDeterministic(input) {
  const s = String(input || '');
  if (!s.trim()) return s;

  // Preserve ⟦Pn⟧ tokens and existing quoted CJK spans separately so quoted CJK
  // never causes surrounding English prose to skip translation.
  const tokens = s.match(TOKEN_RE) || [];
  const quotedCjk = [];
  let out = s.replace(QUOTED_CJK_RE, (m) => {
    const idx = quotedCjk.length;
    quotedCjk.push(m);
    return `\uE000Q${idx}\uE001`;
  });

  // Mask ⟦Pn⟧ temporarily while checking for untranslated English words
  const tokenHolders = [];
  out = out.replace(TOKEN_RE, (tok) => {
    const idx = tokenHolders.length;
    tokenHolders.push(tok);
    return `\uE000T${idx}\uE001`;
  });

  for (const [re, rep] of PHRASE_RULES) {
    out = out.replace(re, rep);
  }

  // Check if unmasked text (outside ⟦Pn⟧ & quoted CJK) still has >=3-letter English prose words
  const proseOnly = out.replace(/\uE000[TQ]\d+\uE001/g, '');
  const remainingWords = (proseOnly.match(/\b[A-Za-z]{3,}\b/g) || []).filter((w) => !PRESERVE_ACRONYMS.has(w));
  if (remainingWords.length > 0) {
    out = translateRemainingEnglishWords(out)
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // Restore temporary placeholders
  out = out
    .replace(/\uE000T(\d+)\uE001/g, (_, idx) => tokenHolders[Number(idx)] ?? '')
    .replace(/\uE000Q(\d+)\uE001/g, (_, idx) => quotedCjk[Number(idx)] ?? '');

  // If still no CJK at all (e.g., short 2-letter words), add genuine Chinese status phrase
  if (!/[\u4e00-\u9fff]/.test(out)) {
    const cleaned = out.replace(TOKEN_RE, '').replace(/\s+/g, ' ').trim();
    const tokenSuffix = tokens.length ? ` ${tokens.join(' ')}` : '';
    out = `已处理${cleaned ? `：${cleaned}` : ''}${tokenSuffix}`.trim();
  } else {
    for (const tok of tokens) {
      if (!out.includes(tok)) out += ` ${tok}`;
    }
  }
  return out;
}

function translatePayload(userText, mode) {
  if (mode === 'drop-placeholder') {
    const stripped = userText.replace(/⟦P\d+⟧/g, '');
    return `中文译文（丢失占位符）：${stripped.trim()}`;
  }
  if (mode === 'corrupt-placeholder') {
    const corrupted = userText.replace(/⟦P(\d+)⟧/g, (_, n) => `⟦P${Number(n) + 99}⟧`);
    return `中文译文（损坏占位符）：${corrupted.trim()}`;
  }

  const trimmed = userText.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return JSON.stringify(parsed.map((item) => (typeof item === 'string' ? translateLineDeterministic(item) : item)));
      }
      if (parsed && typeof parsed === 'object') {
        const mapped = {};
        for (const [k, v] of Object.entries(parsed)) {
          mapped[k] = typeof v === 'string' ? translateLineDeterministic(v) : v;
        }
        return JSON.stringify(mapped);
      }
    } catch {
      // fall through to line-based translation
    }
  }

  return userText
    .split('\n')
    .map((line) => translateLineDeterministic(line))
    .join('\n');
}

export class MockLlmServer {
  #server = null;
  #port = null;
  #mode = 'ok';
  #delayMs = 0;
  #failFirstN = 0;
  #failMode = '429';
  #requests = [];
  #inFlight = 0;
  #maxConcurrent = 0;
  #abortedCount = 0;
  #hungSockets = new Set();

  constructor({ mode = 'ok', delayMs = 0, failFirstN = 0, failMode = '429' } = {}) {
    this.#mode = mode;
    this.#delayMs = delayMs;
    this.#failFirstN = failFirstN;
    this.#failMode = failMode;
  }

  get port() { return this.#port; }
  get baseUrl() { return `http://127.0.0.1:${this.#port}/v1`; }
  get requests() { return this.#requests; }
  get inFlight() { return this.#inFlight; }
  get maxConcurrent() { return this.#maxConcurrent; }
  get abortedCount() { return this.#abortedCount; }

  setMode(mode, { delayMs = this.#delayMs, failFirstN = 0, failMode = '429' } = {}) {
    this.#mode = mode;
    this.#delayMs = delayMs;
    this.#failFirstN = failFirstN;
    this.#failMode = failMode;
  }

  setDelay(delayMs) {
    this.#delayMs = delayMs;
  }

  resetStats() {
    this.#requests = [];
    this.#maxConcurrent = 0;
    this.#abortedCount = 0;
  }

  async start() {
    if (this.#server) return;
    this.#server = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || !/\/chat\/completions\/?$/.test(req.url || '')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Not found' } }));
        return;
      }

      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      let body = {};
      try {
        body = JSON.parse(rawBody || '{}');
      } catch {
        // ignore
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const userMsg = [...messages].reverse().find((m) => m?.role === 'user')?.content || '';
      const reqIndex = this.#requests.length + 1;
      this.#requests.push({
        index: reqIndex,
        at: Date.now(),
        model: body.model || '',
        messages,
        promptText: typeof userMsg === 'string' ? userMsg : JSON.stringify(userMsg),
      });

      this.#inFlight++;
      if (this.#inFlight > this.#maxConcurrent) this.#maxConcurrent = this.#inFlight;

      let finished = false;
      const cleanup = () => {
        if (!finished) {
          finished = true;
          this.#inFlight = Math.max(0, this.#inFlight - 1);
        }
      };

      res.on('close', () => {
        if (!res.writableEnded) this.#abortedCount++;
        cleanup();
      });

      const effectiveMode = this.#failFirstN > 0 && reqIndex <= this.#failFirstN
        ? this.#failMode
        : this.#mode;

      if (effectiveMode === 'hang') {
        this.#hungSockets.add(res);
        res.on('close', () => this.#hungSockets.delete(res));
        return;
      }

      if (this.#delayMs > 0) {
        await new Promise((r) => setTimeout(r, this.#delayMs));
      }
      if (res.destroyed || res.writableEnded) {
        cleanup();
        return;
      }

      if (effectiveMode === '429') {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        res.end(JSON.stringify({ error: { message: 'Rate limit exceeded (mock 429)', type: 'rate_limit_error' } }));
        cleanup();
        return;
      }

      if (effectiveMode === '500') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Internal server error (mock 500)', type: 'server_error' } }));
        cleanup();
        return;
      }

      if (effectiveMode === 'bad-json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{invalid-json');
        cleanup();
        return;
      }

      const content = translatePayload(typeof userMsg === 'string' ? userMsg : JSON.stringify(userMsg), effectiveMode);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: `mock-cmpl-${reqIndex}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'mock-zh-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
      }));
      cleanup();
    });

    await new Promise((resolve) => {
      this.#server.listen(0, '127.0.0.1', () => {
        this.#port = this.#server.address().port;
        resolve();
      });
    });
  }

  async close() {
    for (const res of this.#hungSockets) {
      try {
        res.destroy();
      } catch {
        // ignore
      }
    }
    this.#hungSockets.clear();
    if (!this.#server) return;
    try {
      this.#server.closeAllConnections?.();
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      this.#server.close(() => resolve());
    });
    this.#server = null;
    this.#port = null;
  }
}
