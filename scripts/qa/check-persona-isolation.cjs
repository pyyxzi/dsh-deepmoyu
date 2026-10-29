/**
 * check-persona-isolation.cjs —— 钉住「人格提示词只在鲸鱼摸鱼模式里生效」
 *
 * 为什么必须离线钉住（2026-10-21，使用者第 1 条要求）：
 *   原话「这个提示词不要影响到其他项目的对话啊，要隔离开，这个鲸鱼摸鱼提示词单独在
 *   鲸鱼摸鱼模式里面就行，不要注入到全局」。
 *   这条一旦松掉，表现是**别的项目对话里突然冒出鱼味** —— 而且不会有任何报错，
 *   只有在用户某天开一个新项目聊天时才会被发现。等那时候才知道就太晚了。
 *
 * 怎么测：造一个假 ctx（带真的 systemPrompt.section 收集器），`apply()` 之后
 *   把注册进去的 `text(context)` 拿回来，用不同形状的 agent 各调一次，数
 *   「人格设定」这四个字到底出没出现。
 *
 * 用法：`node devtools/check-persona-isolation.cjs`
 *   （设 BILI_PLUGIN_DIR 指向插件源目录；不设就用 profile 里的 junction）
 * 退出码：0 = 全过；1 = 有断言失败；2 = 找不到插件
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const PLUGIN = path.resolve(process.env.BILI_PLUGIN_DIR || path.join(__dirname, '..', '..'))

let pass = 0
const fails = []
/** ⚠️ 签名是 ok(cond, name, detail) —— 被测的东西必须站第一个参数位（写反会永久假绿） */
const ok = (cond, name, detail) => {
  if (cond) { pass++; return }
  fails.push(name + (detail ? ` —— ${detail}` : ''))
}

const PERSONA_TAG = '你的人格设定'
const FEIYU_TAG = '🐟 鲸鱼摸鱼模式（正在这个会话里刷 B站）'
/** 假人格：只要它出现在文本里，就说明人格段被注入了 */
const FAKE_PERSONA = '本鱼是一只测试用的电子鱼，只在被点名的时候出现。'

;(async () => {
  const INDEX = path.join(PLUGIN, 'index.js')
  if (!fs.existsSync(INDEX)) {
    console.error(`✗ 找不到 ${INDEX}\n  （设 BILI_PLUGIN_DIR 指向插件源目录）`)
    process.exit(2)
  }

  const sandboxes = []
  const tempHome = (label) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-deepmoyu-persona-${label}-`))
    sandboxes.push(dir)
    return dir
  }
  const SANDBOX = tempHome('isolation')
  process.on('exit', () => {
    for (const dir of sandboxes) {
      const resolved = path.resolve(dir)
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('dsh-deepmoyu-persona-')) continue
      try { fs.rmSync(resolved, { recursive: true, force: true }) } catch { /* only this run's owned temporary homes */ }
    }
  })

  /* ── 假宿主 ──
   * 只实现 apply() 真正会碰的那几个服务；其余 get() 一律 undefined（跟 selfcheck 一致）。
   * 关键：systemPrompt.section 把注册进来的 section 收下来，供下面直接调用。 */
  const sections = {}
  const tools = {}
  const scopedSeed = { id: 'scope-capture-only', session: { header: { agentPreset: 'dafeiyu' } },
    ctx: { tools: { register: (t) => { tools[t.name] = t; return () => { delete tools[t.name] } } } } }
  const handlers = {}
  let goalWrites = 0
  let goalsGet = () => null
  const fakeCtx = {
    get: (k) => {
      if (k === 'dshHomePath') return (...seg) => path.join(SANDBOX, ...seg)
      if (k === 'systemPrompt') {
        return {
          getSectionOrder: () => 600,
          section: (s) => { sections[s.name] = s; return { dispose() {} } },
        }
      }
      if (k === 'goals') return {
        get: (agent) => goalsGet(agent),
        create: () => { goalWrites++; throw new Error('unexpected goal create') },
        resume: () => { goalWrites++; throw new Error('unexpected goal resume') },
        set: () => { goalWrites++; throw new Error('unexpected goal set') },
        edit: () => { goalWrites++; throw new Error('unexpected goal edit') },
      }
      if (k === 'agents') return { list: () => [scopedSeed] }
      return undefined
    },
    logger: { info: () => {}, warn: () => {} },
    tools: { register: () => { throw new Error('Global fish tool registration is forbidden') } },
    webServer: { register: () => ({ dispose() {} }) },
    effect: (fn) => { try { return fn() } catch { return undefined } },
    settings: { register: () => ({}) },
    slots: { inject: () => {}, register: () => ({}) },
    on: (event, fn) => { handlers[event] = fn; return { dispose() {} } },
  }

  // 造一个「配置里写了人格」的家目录：apply 时 refreshCfg 会读它
  // ⚠️ 路径是 <home>/bili-duty/config.json —— `dshHomePath('bili-duty')` 那一层别漏
  const sandboxState = path.join(SANDBOX, 'bili-duty')
  fs.mkdirSync(sandboxState, { recursive: true })
  fs.writeFileSync(path.join(sandboxState, 'config.json'), JSON.stringify({
    persona: FAKE_PERSONA, _set: ['persona'],
  }), 'utf8')

  const mod = await import('file:///' + INDEX.replace(/\\/g, '/'))
  try {
    mod.apply(fakeCtx, {})
  } catch (e) {
    console.error(`✗ apply() 就抛了：${e?.message ?? e}`)
    process.exit(1)
  }

  const sec = sections['bili:dafeiyu']
  ok(Boolean(sec) && typeof sec.text === 'function', '系统提示词段 bili:dafeiyu 挂上了')
  if (!sec) { report(); return }

  const runText = (context) => {
    try { return String(sec.text(context) ?? '') } catch (e) { return `__THREW__:${e?.message ?? e}` }
  }
  const callTool = async (name, args = {}, agent) => {
    const registered = tools[name]
    if (!registered || typeof registered.execute !== 'function') throw new Error(`tool not captured: ${name}`)
    return registered.execute(args, agent ? { agent } : undefined)
  }
  const auditBytes = () => JSON.stringify(['activity.jsonl', 'feiyu.json'].map((name) => {
    const file = path.join(sandboxState, name)
    return [name, fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null]
  }))
  const traceStateIO = async (run) => {
    const touched = []
    const saved = {}
    const root = path.resolve(sandboxState).toLowerCase()
    for (const method of ['readFileSync', 'writeFileSync', 'appendFileSync', 'openSync', 'readdirSync', 'statSync', 'mkdirSync', 'renameSync', 'rmSync']) {
      saved[method] = fs[method]
      fs[method] = function (...args) {
        if (typeof args[0] === 'string') {
          const file = path.resolve(args[0]).toLowerCase()
          if (file === root || file.startsWith(root + path.sep)) touched.push(`${method}:${args[0]}`)
        }
        return saved[method].apply(this, args)
      }
    }
    require('node:module').syncBuiltinESMExports()
    try { await run() } finally {
      Object.assign(fs, saved)
      require('node:module').syncBuiltinESMExports()
    }
    return touched
  }

  /** 造一个假 agent；`preset` 走哪一层由参数决定 */
  const makeAgent = (opts = {}) => {
    const agent = { id: opts.id || 'agent-test', session: {}, ctx: { tools: { register: t => t } } }
    if (opts.headerPreset !== undefined) agent.session.header = { agentPreset: opts.headerPreset }
    if (opts.agentField !== undefined) agent.agentPreset = opts.agentField
    // ⭐ 2026-10-21 加：会话说自己真选过什么（`session.log` 里的 agent-preset/selected 事件）
    if (opts.selected !== undefined) {
      agent.session.log = (opts.selectedLog || []).concat([{
        type: 'agent-preset/selected',
        data: { agentPreset: opts.selected },
      }])
    }
    if (opts.selectedLog !== undefined) agent.session.log = opts.selectedLog
    return agent
  }

  console.log('═══ ① 别的项目对话（没有任何 preset 痕迹）⇒ 一个字都不许注入 ═══')
  {
    const out = runText({ agent: makeAgent({ id: 'proj-1' }) })
    ok(!out.includes(FAKE_PERSONA), '非鱼模式会话：人格原文没被注入', clip(out))
    ok(!out.includes(PERSONA_TAG), '非鱼模式会话：连「你的人格设定」这个抬头都没有', clip(out))
    ok(!out.includes(FEIYU_TAG), '非鱼模式会话：鲸鱼摸鱼模式段也没进来', clip(out))
    ok(out === '', '非鱼模式 + 没在刷 ⇒ 这一段整个是空的（连空行都不占）', JSON.stringify(out.slice(0, 80)))
  }

  console.log('\n═══ ② 拿不到 agent（后台 / 定时器那种上下文）⇒ 同样不许注入 ═══')
  {
    const out = runText(undefined)
    ok(!out.includes(FAKE_PERSONA), 'context 是空的：照样不注入人格')
    ok(!out.includes(FEIYU_TAG), 'context 是空的：也没有鲸鱼摸鱼模式段')
    const out2 = runText({})
    ok(!out2.includes(FAKE_PERSONA), 'context 里没有 agent：照样不注入人格')
  }

  console.log('\n═══ ③ session.header.agentPreset = standard ⇒ 不许注入 ═══')
  {
    const out = runText({ agent: makeAgent({ id: 'proj-2', headerPreset: 'standard' }) })
    ok(!out.includes(FAKE_PERSONA), 'standard 预设：人格原文没被注入', clip(out))
  }

  console.log('\n═══ ④ session.header.agentPreset = dafeiyu ⇒ 必须注入 ═══')
  {
    const out = runText({ agent: makeAgent({ id: 'fish-1', headerPreset: 'dafeiyu' }) })
    ok(out.includes(FAKE_PERSONA), '选了鱼模式预设：人格原文进来了', clip(out))
    ok(out.includes(PERSONA_TAG), '选了鱼模式预设：抬头也在')
    ok(out.indexOf(PERSONA_TAG) < (out.indexOf(FEIYU_TAG) === -1 ? Infinity : out.indexOf(FEIYU_TAG)),
      '人格段排在鲸鱼摸鱼模式段前面（先是谁，再是干什么）')
  }

  console.log('\n═══ ⑤ 未记录在宿主投影/header中的任意agent字段不授予角色 ═══')
  {
    const out = runText({ agent: makeAgent({ id: 'fish-2', agentField: 'dafeiyu' }) })
    ok(out === '', '任意agent.agentPreset字段不作为宿主预设选择依据')
  }

  console.log('\n═══ ⑥ 判定优先级：宿主接口说了算，header 只是兜底 ═══')
  {
    // 让 sessionProjections 说 standard（比 header 优先），header 假装是 dafeiyu
    const agent = makeAgent({ id: 'proj-3', headerPreset: 'dafeiyu' })
    const ctx2 = fakeCtx // 同一个 apply，但下面临时改 get('sessionProjections')
    const origGet = fakeCtx.get
    fakeCtx.get = (k) => (k === 'sessionProjections'
      ? { stateOf: () => 'standard' }
      : origGet(k))
    const out = runText({ agent })
    fakeCtx.get = origGet
    ok(!out.includes(FAKE_PERSONA), 'session projections 说 standard ⇒ 以它为准，不注入', clip(out))
  }

  console.log('\n═══ ⑦ 残留goal不能给未知/普通会话授予人格 ═══')
  {
    // 真刷着的时候必须有鱼味，否则就是「一个没有灵魂的爬虫在发评论」
    goalsGet = () => ({ phase: 'active', activation: 'armed', objective: '🐟 鲸鱼摸鱼模式' })
    const out = runText({ agent: makeAgent({ id: 'proj-4' }) })
    goalsGet = () => null
    ok(out === '', '没选preset，即使残留活鱼goal也严格零注入', clip(out))
  }

  console.log('\n═══ ⑨ soul 账本也跟着人格段一起隔离（不能漏进别的项目）═══')
  {
    // 先往沙箱家目录里写一段「只有鱼才会有的记忆」
    const soulFile = path.join(SANDBOX, 'bili-duty', 'soul.md')
    fs.writeFileSync(soulFile, [
      '# 我自己', '',
      '## 我最近的心情', '- 10-21 被风控拦了一次，有点蔫', '',
      '## 我惦记的事', '- 10-21 那个修表老哥还差三期', '',
      '## 我对自己学到的事', '', '', '## 下次想试试', '',
    ].join('\n'), 'utf8')

    const proj = runText({ agent: makeAgent({ id: 'proj-5', headerPreset: 'standard' }) })
    ok(!proj.includes('修表老哥'), 'standard 预设：soul.md 的内容一个字都没漏进来', clip(proj))
    ok(!proj.includes('你自己那本账'), 'standard 预设：连 soul 的抬头都没有', clip(proj))

    const fish = runText({ agent: makeAgent({ id: 'fish-4', headerPreset: 'dafeiyu' }) })
    ok(fish.includes('修表老哥'), '选了鱼模式：soul.md 的内容真读进来了', clip(fish))
    ok(fish.includes('你自己那本账'), '选了鱼模式：soul 抬头在')
    ok(fish.indexOf(PERSONA_TAG) < fish.indexOf('你自己那本账'),
      '顺序：人格 → soul → 鲸鱼摸鱼模式（先是谁，再是上一轮的她，再是干什么）')

    // 只选了鱼模式、没在刷 —— 照样要记得上一轮（"连着上一轮活"不是"上班才记得自己是谁"）
    ok(fish.includes('修表老哥'), '选了鱼模式但没在刷：上一轮的心情照样读得回来')
  }

  console.log('\n═══ ⑩ 别的正经 goal 挂着（"改这个插件"）⇒ 不算在刷，不许注入 ═══')
  {
    // ⚠️ 这条是 2026-10-21 真踩到的：只看 active+armed 会把「任何活着的 goal」当成在刷，
    //    结果标准模式的对话里被塞了一嘴鱼味。判据必须再核对 goal 抬头是不是鲸鱼摸鱼。
    goalsGet = () => ({ phase: 'active', activation: 'armed', objective: '修改一下这个插件，dsh-deepmoyu' })
    const out = runText({ agent: makeAgent({ id: 'proj-6', headerPreset: 'standard' }) })
    goalsGet = () => null
    ok(!out.includes(FAKE_PERSONA), '顶着别的 goal 的 standard 会话：人格一个字都不许有', clip(out))
    ok(!out.includes('鲸鱼摸鱼模式'), '顶着别的 goal 的 standard 会话：连模式段都不许有', clip(out))
  }

  console.log('\n═══ ⑪ 🕐 时间感也走同一道门禁（别的项目不该知道"鱼几点"）═══')
  {
    // 2026-10-21 加：模型没有时钟，宿主每轮现算一句「现在是 晚上 21:40（周三）」
    // 跟人格/soul 一样必须只在鱼模式里出现 —— 否则别的项目对话里会冒出一句莫名其妙的报时。
    const std = runText({ agent: makeAgent({ id: 'proj-clock', headerPreset: 'standard' }) })
    const fish = runText({ agent: makeAgent({ id: 'fish-clock', headerPreset: 'dafeiyu' }) })
    ok(!std.includes('现在几点'), 'standard 会话：不许有「现在几点」的时间段', clip(std))
    ok(!std.includes('别跟这个时间打架'), 'standard 会话：不许有时间感那句提醒', clip(std))
    ok(fish.includes('现在几点'), '鱼模式：时间感必须在', clip(fish))
    ok(/\d{1,2}:\d{2}/.test(fish), '鱼模式：时间段里真的有具体点钟（不是空壳）', clip(fish))
  }

  console.log('\n═══ ⑧ 人格段被关掉时，鲸鱼摸鱼模式段自己也要能立住 ═══')
  {
    // 把人格清空，重开一个沙箱跑一遍：模式段不许因为人格为空而整段消失
    const S2 = tempHome('empty-persona')
    fs.mkdirSync(path.join(S2, 'bili-duty'), { recursive: true })
    fs.writeFileSync(path.join(S2, 'bili-duty', 'config.json'), JSON.stringify({ persona: '', _set: ['persona'] }), 'utf8')
    const sections2 = {}
    const ctx2 = {
      ...fakeCtx,
      get: (k) => {
        if (k === 'dshHomePath') return (...seg) => path.join(S2, ...seg)
        if (k === 'systemPrompt') return { getSectionOrder: () => 600, section: (s) => { sections2[s.name] = s; return { dispose() {} } } }
        if (k === 'goals') return { get: () => ({ phase: 'active', activation: 'armed', objective: '🐟 鲸鱼摸鱼模式' }) }
        return undefined
      },
    }
    // 清缓存，重新 import 一份（模块级有状态，换个 query 骗过 ESM 缓存）
    const mod2 = await import('file:///' + INDEX.replace(/\\/g, '/') + '?iso2=' + Date.now())
    mod2.apply(ctx2, {})
    const out = String(sections2['bili:dafeiyu']?.text({ agent: { id: 'fish-3', session: { header: { agentPreset: 'dafeiyu' } } } }) ?? '')
    ok(!out.includes(PERSONA_TAG), '人格留空 ⇒ 没有空的人格段（不留 "=====" 空壳）')
    ok(out.includes('鲸鱼摸鱼模式'), '人格留空 ⇒ 鲸鱼摸鱼模式段照旧在（这两段互不依赖）', clip(out))
  }

  console.log('\n═══ ⑫ ⭐ 最隐蔽那个：header 是创建时的快照，真选过什么在 session.log 里 ═══')
  {
    // ⚠️⚠️ 2026-10-21 真机抓到的第二个隔离漏洞：
    //   使用者先建会话（此时 header 写死 agentPreset='standard'，永远是 standard），
    //   再在下拉框里切成「🐟 鲸鱼摸鱼模式」⇒ 只有一条 agent-preset/selected 事件记着真话。
    //   实测 290 个会话里有 12 个是这种形状。
    //   只读 header 的后果：**真在鱼模式里的会话被当成不是鱼**，人格/soul/时钟全消失，
    //   而且不会报错 —— 使用者只会觉得"鱼怎么变木了"。

    // ⑫.1 header=standard 但真选了 dafeiyu ⇒ 必须注入
    const fish = runText({ agent: makeAgent({ id: 'fish-real', headerPreset: 'standard', selected: 'dafeiyu' }) })
    ok(fish.includes(FAKE_PERSONA), '⑫ header=standard + 真选过 dafeiyu：人格必须注入（这就是真机那 12 个会话）', clip(fish))
    ok(fish.includes('🐟 鲸鱼摸鱼模式'), '⑫ header=standard + 真选过 dafeiyu：模式段也要在', clip(fish))

    // ⑫.2 反过来：header=dafeiyu 但最后又切回了 standard ⇒ 不许注入
    const back = runText({ agent: makeAgent({ id: 'fish-back', headerPreset: 'dafeiyu', selected: 'standard' }) })
    ok(!back.includes(FAKE_PERSONA), '⑫ header=dafeiyu + 最后切回 standard：不许注入（事件比 header 新）', clip(back))

    // ⑫.3 选过很多次：只认最后一条
    const many = runText({
      agent: makeAgent({
        id: 'fish-many',
        headerPreset: 'standard',
        selectedLog: [
          { type: 'agent-preset/selected', data: { agentPreset: 'dafeiyu' } },
          { type: 'agent-preset/selected', data: { agentPreset: 'standard' } },
          { type: 'agent-preset/selected', data: { agentPreset: 'dafeiyu' } },
        ],
      }),
    })
    ok(many.includes(FAKE_PERSONA), '⑫ 切过多次（鱼→标准→鱼）：只认最后一条，仍然注入', clip(many))

    // ⑫.4 明确选回「无预设」(null) ⇒ 以事件为准，不许再拿 header 兜底
    const noPreset = runText({ agent: makeAgent({ id: 'fish-null', headerPreset: 'dafeiyu', selected: null }) })
    ok(!noPreset.includes(FAKE_PERSONA), '⑫ 事件里明确选了 null（无预设）：不许退回 header 兜底注入', clip(noPreset))

    // ⑫.5 session.log 不是数组 / 是空的 / 事件形状歪掉 ⇒ 都不许抛，退到 header
    const weird = runText({ agent: { id: 'fish-weird', session: { header: { agentPreset: 'dafeiyu' }, log: 'not-an-array' } } })
    ok(weird.includes(FAKE_PERSONA), '⑫ session.log 形状不对：不抛，退回 header 兜底', clip(weird))
    const weird2 = runText({ agent: { id: 'fish-weird2', session: { header: { agentPreset: 'dafeiyu' }, log: [null, {}, 'x'] } } })
    ok(weird2.includes(FAKE_PERSONA), '⑫ session.log 里全是垃圾事件：不抛，退回 header 兜底', clip(weird2))
    const broken = runText({ agent: { id: 'fish-broken', session: { header: { agentPreset: 'dafeiyu' }, log: [{ type: 'agent-preset/selected', data: null }] } } })
    // ⚠️ 这条**必须不注入**：事件在、但读不出选的是谁 ⇒ 拿不准。隔离优先（宁可少注入一次，
    //    也不许漏进别人的项目）⇒ 当"不是鱼"处理，不许退回 header 猜。
    ok(!broken.includes(FAKE_PERSONA), '⑫ 事件在但 data 是 null：读不准 ⇒ 按隔离优先当"不是鱼"，不许拿 header 猜', clip(broken))

    // ⑫.6 soul 也要跟着这条新判据走（最容易漏的地方）
    const fishSoul = runText({ agent: makeAgent({ id: 'fish-soul-log', headerPreset: 'standard', selected: 'dafeiyu' }) })
    ok(fishSoul.includes('修表老哥'), '⑫ header=standard + 真选过 dafeiyu：soul 的记忆也要读回来（别只改了人格漏了 soul）', clip(fishSoul))
  }

  console.log('\n═══ ⑬ 显式退出覆盖旧 active+armed 鱼 goal，提示词和认领均无副作用 ═══')
  {
    const oldGoal = { id: 'old-fish-goal', phase: 'active', activation: 'armed', objective: '🐟 鲸鱼摸鱼模式：旧任务', roundsStarted: 3, maxGoalRounds: 64 }
    const cases = [
      { name: 'header standard', opts: { headerPreset: 'standard' } },
      { name: 'header null', opts: { headerPreset: null } },
      { name: 'event null', opts: { headerPreset: 'dafeiyu', selected: null } },
      { name: 'host null', opts: { headerPreset: 'dafeiyu' }, service: 'agentPresets', value: null },
      { name: 'host empty', opts: { headerPreset: 'dafeiyu' }, service: 'agentPresets', value: '' },
      { name: 'projection null', opts: { headerPreset: 'dafeiyu' }, service: 'sessionProjections', value: null },
    ]
    goalsGet = () => oldGoal
    for (const [i, one] of cases.entries()) {
      const agent = makeAgent({ id: `blocked-old-goal-${i}`, ...one.opts })
      const before = auditBytes()
      const original = fakeCtx.get
      if (one.service) fakeCtx.get = (key) => key === one.service
        ? (key === 'agentPresets' ? { composedPreset: () => one.value } : { stateOf: () => one.value })
        : original(key)
      try {
        const out = runText({ agent })
        ok(out === '', `⑬ ${one.name} + 旧鱼goal：输出严格空字符串`, clip(out))
        handlers['agent/status']?.({ agent, status: 'idle' })
      } finally { fakeCtx.get = original }
      ok(auditBytes() === before, `⑬ ${one.name} 新agent不认领、不写activity/feiyu.json`)
    }
    goalsGet = () => null
  }

  console.log('\n═══ ⑭ 私有记忆工具在外模式/无agent立即拒绝，不读写状态 ═══')
  {
    const privateCalls = [
      ['bili_soul', { action: 'read', all: true }],
      ['bili_soul', { action: 'append', section: 'mood', text: 'PRIVATE_DENIED_WRITE' }],
      ['bili_learn', { action: 'review' }],
      ['bili_learn', { action: 'add', kind: 'style', text: 'PRIVATE_DENIED_LEARNING' }],
      ['bili_taste', { action: 'digest' }],
      ['bili_records', { type: 'memory', num: 10 }],
      ['bili_sticker', { action: 'list' }],
      ['bili_sticker', { action: 'collect', name: 'PRIVATE_DENIED_STICKER', path: 'x' }],
    ]
    goalsGet = () => ({ phase: 'active', activation: 'armed', objective: '🐟 鲸鱼摸鱼模式：已退出' })
    for (const [i, agent] of [makeAgent({ id: 'private-standard', headerPreset: 'standard' }), makeAgent({ id: 'private-none', headerPreset: null }), undefined].entries()) {
      const before = auditBytes()
      const touched = await traceStateIO(async () => {
        for (const [name, args] of privateCalls) {
          const result = await callTool(name, args, agent)
          ok(result?.ok === false && result?.blocked === true && result?.reason === 'mode_required',
            `⑭ ${name}/${args.action || args.type} 上下文${i}：mode_required`, JSON.stringify(result))
        }
      })
      ok(touched.length === 0, `⑭ 上下文${i}：私有门禁零状态IO`, touched.slice(0, 3).join(' | '))
      ok(auditBytes() === before, `⑭ 上下文${i}：无活动或goal写入`)
    }
    goalsGet = () => null
  }

  console.log('\n═══ ⑮ 审批学习每请求现读，只在鱼模式出现，拒绝/撤销立即消失 ═══')
  {
    const agent = makeAgent({ id: 'learning-fish', headerPreset: 'dafeiyu' })
    const tokens = {
      approved: 'APPROVED_LEARNING_ONLY_5142', pending: 'PENDING_LEARNING_NEVER_5142',
      rejected: 'REJECTED_LEARNING_NEVER_5142', forgotten: 'FORGOTTEN_LEARNING_NEVER_5142',
    }
    const learn = await import(require('node:url').pathToFileURL(path.join(PLUGIN, 'lib', 'learn.mjs')).href)
    const fixtureState = path.join(sandboxState, 'state.json')
    const mutateFixture = (fn) => {
      const state = fs.existsSync(fixtureState) ? JSON.parse(fs.readFileSync(fixtureState, 'utf8')) : {}
      const result = fn(state.learn || {})
      if (result.ledger) fs.writeFileSync(fixtureState, JSON.stringify({ ...state, learn: result.ledger, learnRevision: (state.learnRevision || 0) + 1 }), 'utf8')
      return result
    }
    const decide = (id, action) => mutateFixture((book) => learn.learnDecide(book, id, action, 'offline human-review fixture'))
    const forget = (id) => mutateFixture((book) => learn.learnForget(book, { id }))
    const ids = {}
    for (const [name, text] of Object.entries(tokens)) {
      const r = mutateFixture((book) => learn.learnAdd(book, { kind: 'style', text, from: 'offline persona regression' }))
      ok(r?.added === true && Boolean(r?.id), `⑮ ${name} 进入纯待审夹具`, JSON.stringify({ id: r.id, added: r.added }))
      ids[name] = r.id
    }
    let out = runText({ agent })
    ok(!Object.values(tokens).some((token) => out.includes(token)), '⑮ pending一条也不注入')
    const beforeReview = JSON.stringify(JSON.parse(fs.readFileSync(fixtureState, 'utf8')).learn)
    for (const action of ['approve', 'reject']) {
      const denied = await callTool('bili_learn', { action, id: ids.pending }, agent)
      ok(denied?.ok === false && denied?.review_required === true, `⑮ 模型工具${action}必须交人工审查`, JSON.stringify(denied))
    }
    ok(JSON.stringify(JSON.parse(fs.readFileSync(fixtureState, 'utf8')).learn) === beforeReview, '⑮ 模型审批请求不改变临时学习账本')
    decide(ids.approved, 'approve')
    decide(ids.rejected, 'reject')
    decide(ids.forgotten, 'approve')
    forget(ids.forgotten)
    out = runText({ agent })
    ok(out.includes(tokens.approved), '⑮ 批准后紧接请求就注入，无缓存重启')
    ok(!out.includes(tokens.pending), '⑮ pending仍不注入')
    ok(!out.includes(tokens.rejected), '⑮ rejected不注入')
    ok(!out.includes(tokens.forgotten), '⑮ forgotten不注入')
    const standard = runText({ agent: makeAgent({ id: 'learning-standard', headerPreset: 'standard' }) })
    ok(standard === '', '⑮ approved在standard仍严格空字符串')
    decide(ids.approved, 'reject')
    ok(!runText({ agent }).includes(tokens.approved), '⑮ 已批准改拒绝，下一请求立即撤下注入')
    decide(ids.approved, 'approve')
    ok(runText({ agent }).includes(tokens.approved), '⑮ 再批准，下一请求立即恢复')
    forget(ids.approved)
    ok(!runText({ agent }).includes(tokens.approved), '⑮ 撤销，下一请求立即消失')
  }

  console.log('\n═══ ⑯ 实时配额每请求更新；只选模式是闲聊，不自动启动 ═══')
  {
    const configFile = path.join(sandboxState, 'config.json')
    const stateFile = path.join(sandboxState, 'state.json')
    const setConfig = (fields) => {
      const current = JSON.parse(fs.readFileSync(configFile, 'utf8'))
      fs.writeFileSync(configFile, JSON.stringify({ ...current, ...fields, _set: [...new Set([...(current._set || []), ...Object.keys(fields)])] }), 'utf8')
    }
    const setState = (fields) => {
      const current = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}
      fs.writeFileSync(stateFile, JSON.stringify({ ...current, ...fields }), 'utf8')
    }
    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    setConfig({ perDay: 17, autoComment: false })
    setState({ day, picked: 2 })
    goalsGet = () => ({ id: 'live-quota-goal', phase: 'active', activation: 'armed', objective: '🐟 鲸鱼摸鱼模式：配额回归', roundsStarted: 2, maxGoalRounds: 64 })
    const agent = makeAgent({ id: 'quota-live', headerPreset: 'dafeiyu' })
    const first = runText({ agent })
    ok(first.includes('今天挑中 2/17') && first.includes('最多还能挑 15'), '⑯ 第一次请求读到当前17条额度与已挑2条', clip(first))
    ok(first.includes('评论：关'), '⑯ 第一次请求读到评论关闭')
    setConfig({ perDay: 29, autoComment: true })
    setState({ day, picked: 5 })
    const second = runText({ agent })
    ok(second.includes('今天挑中 5/29') && second.includes('最多还能挑 24'), '⑯ 不重启、不重建goal，下一请求立即变29/已挑5', clip(second))
    ok(second.includes('评论：开，想说再说'), '⑯ 发送开关变化随下一请求刷新')
    goalsGet = () => null
    const before = auditBytes()
    const goalWritesBefore = goalWrites
    const idle = runText({ agent: makeAgent({ id: 'chat-only-fish', headerPreset: 'dafeiyu' }) })
    ok(idle.includes(FAKE_PERSONA), '⑯ 日常选鱼模式仍有人格')
    ok(!idle.includes(FEIYU_TAG) && !idle.includes('【实时配额】'), '⑯ 没有goal时不出现正在刷/实时任务配额')
    ok(goalWrites === goalWritesBefore && auditBytes() === before, '⑯ 只选模式不创建goal、不认领、不自动启动')
  }

  report()

  function clip(s) {
    const one = String(s).replace(/\s+/g, ' ').trim()
    return one.length > 120 ? one.slice(0, 120) + '…' : one
  }
  function report() {
    if (fails.length === 0) {
      console.log(`\n✓ 人格隔离 ${pass} 项断言全过（非鱼模式零注入 / 鱼模式必注入 / 判定优先级）`)
      process.exit(0)
    }
    console.log(`\n✗ ${fails.length} 项失败（通过 ${pass} 项）：`)
    for (const f of fails) console.log('  · ' + f)
    process.exit(1)
  }
})()
