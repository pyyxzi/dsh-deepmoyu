/**
 * dsh-deepmoyu —— 浏览器半端（**设置全在桌宠那只鱼身上，DSH 的「设置」里不再有刷B站**）
 * ============================================================================
 * ⭐ **client bundle 不是 ESM，是自注册脚本**（2026-10-14 从官方包里挖到的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                       // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * ⭐ **2026-10-26 使用者改口（m00717）：「当前鲸鱼摸鱼的设置不要在 dsh 的默认设置里」**
 *   ⇒ 原来那段（抄 `dsh-meme`）的注册已经**整段删掉**：
 *
 *       slots.inject('settings.section', () => slots.register(
 *         { name: 'settings.section', id: 'dafeiyu', order: 30, label: '刷B站' }, …))   // ✗ 已移除
 *
 *   现在的入口只有一条：**点桌宠 → 弹菜单 → ⚙️ 设置 → 弹窗**（PetSettingsModal）。
 *   弹窗九项侧栏：偏好与桌宠 / 运行方式 / 互动与投递 / 表情收藏 / 学习与记忆 /
 *   token 账本 / 运行日志 / 日报视频 / 账号与环境；仅构建当前页，账本独立并支持截图。
 *   ⇒ `inject` 也跟着清空成 `[]`，apply() 只做两件事：挂样式、挂桌宠。
 *   ⚠️ 别再加回 settings.section —— selfcheck.mjs 会直接判红。
 *
 * 这一页要满足使用者 2026-10-14 说的形状（现在这些都长在弹窗里）：
 *   · **总开关 → 打开之后下面才展开子开关**（峰谷自动刷 → 中午 / 晚上）
 *   · **数字项要能自己填**（定量刷：每天几条）
 *   · **账号绑定必须在设置里**（扫码登录 + 二维码直接显示在页面里）
 *   · 会发东西出去的（自动评论）、要下大模型的（本地转写）**默认关**
 *
 * ⭐ 桌宠：本文件在 document.body 上挂一只常驻贴图鱼（不走 slots —— 自建 DOM +
 *   react-dom root 渲染，见文件尾部「🐾 桌宠」那一大段）。单击鱼=弹菜单，双击=直接
 *   「新开会话刷」；藏起来之后右下角留一个小圆点，点它把鱼叫回来。
 *   （原来的唤回入口是「设置 → 刷B站 → 显示桌宠」，设置页没了，所以补了这个圆点。）
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepmoyu',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /* 私信「晾太久就不回了」的天数 —— 跟宿主 `lib/dm.mjs` 的 `DM_STALE_DAYS` 必须一致。
     * client bundle 不是 ESM（见文件头），没法 import 那个模块，所以在这里再钉一个常量；
     * 断言脚本（devtools/render-panel.cjs）会核对文案里出现的数字，改一处漏一处会被抓出来。 */
    const DM_STALE_DAYS = 3

    /* 🪞 她自己那本账的四节（跟宿主 `lib/persona.mjs` 的 SOUL_SECTIONS 一一对应）。
     * client bundle 不是 ESM，import 不了，所以在这里再钉一份；只用来显示与清空。 */
    const SOUL_SECTION_LABELS = [['mood', '最近的心情'], ['crave', '惦记的事'], ['self', '对自己的认识'], ['next', '下次想试试']]

    const API = '/api/bili-duty'
    /* 🐟 桌宠本体贴图：后端 `GET /api/bili-duty/pet/image?name=pet` → `assets/pet/pet.png`
     *（554×561 透明 PNG，247KB）。不塞 base64 进 bundle：白膨胀 330KB，且这样能走浏览器缓存。
     * 路由不在 / 文件丢了时 <img> 会 onError，PetFish 自动退回原来那条纯 CSS 胖鱼。 */
    const PET_IMG_URL = API + '/pet/image?name=pet'
    /* 🪞 弹窗头像位用的是角色立绘的**脸部特写**（assets/avatar/face.png，512×512 圆图）——
     *   比抽象小图标有人味。图挂了 onError 退回原来的图标，不会留一个破图框。 */
    const PET_AVATAR_URL = API + '/pet/image?name=face'
    /* ⚠️ 原来 jget/jpost 直接 .json()、从不看 res.ok ⇒ HTTP 500 的 {ok:false,error}
     *    会被调用方当成「已保存 / 成功」，绿色提示把故障盖掉。（2026-10-16 审查修） */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      let detail
      try { detail = await res.json() } catch { /* Some older hosts return a plain 404 page. */ }
      const message = typeof detail?.error === 'string' ? detail.error.slice(0, 500) : ''
      const error = new Error('HTTP ' + res.status + why + (message ? '：' + message : ''))
      error.status = res.status
      error.code = detail?.code
      throw error
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-bd-page]{display:flex;flex-direction:column;gap:14px;padding:2px 2px 8px;max-width:680px;}
/* ⭐ 卡片：七段内容原来只靠 gap 分隔，视觉上糊成一片 ⇒ 每段一张卡，边界一眼可辨 */
[data-bd-sec]{display:flex;flex-direction:column;gap:8px;padding:13px 14px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.07));}
[data-bd-sec][data-flat]{padding:0;border:0;background:none;}
[data-bd-h]{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:.04em;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-h] b{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);letter-spacing:0;}
/* ⚠️ 原来没有 flex-wrap ⇒ 顶部那一排 badge + 按钮会溢出被裁掉（2026-10-20 使用者截图指出的"布局有问题"） */
[data-bd-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-bd-row][data-nowrap]{flex-wrap:nowrap;}
[data-bd-grow]{flex:1 1 140px;min-width:0;}
[data-bd-label]{font-size:13px;}
[data-bd-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-bd-sw][data-on]{background:#38bdf8;}
[data-bd-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  box-shadow:0 1px 2px rgba(6,40,64,.25);
  transition:left .2s cubic-bezier(.34,1.56,.64,1);display:block;}
[data-bd-sw][data-on] i{left:19px;}
[data-bd-sw][disabled]{opacity:.45;cursor:default;}
[data-bd-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  display:flex;flex-direction:column;gap:10px;}
/* ⭐ 表单行：标签在左、控件在右（这是设置页的常规排版），但光有间距时控件像"飘在右边"。
 *   给每行加一条很淡的分隔线，一列下来就读成"表单"而不是"撒了一地控件"。
 *   （2026-10-20 截图复查：数字框全贴右边缘、中间空一大片，看着像布局坏了） */
[data-bd-sub] > [data-bd-row]{padding:6px 0;gap:12px;
  border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.055));}
[data-bd-sub] > [data-bd-row]:last-child{border-bottom:0;}
[data-bd-sub] > [data-bd-note]{margin-top:-4px;}
[data-bd-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-bd-input]:focus{outline:none;border-color:#3b82f6;}
[data-bd-num]{width:88px;text-align:center;flex:none;}
[data-bd-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;
  transition:background .15s ease,border-color .15s ease,box-shadow .15s ease,transform .15s ease;}
[data-bd-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-bd-btn]:active:not(:disabled){transform:translateY(1px) scale(.99);}
[data-bd-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-bd-btn][data-sm]{padding:4px 9px;font-size:11px;}
[data-bd-btn][disabled]{opacity:.5;cursor:default;}
[data-bd-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-word;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-msg][data-warn]{color:#f59e0b;}
[data-bd-msg][data-good]{color:#22c55e;}
[data-bd-qr]{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;}
[data-bd-qr] img{width:150px;height:150px;border-radius:8px;background:#fff;padding:6px;}
[data-bd-pre]{margin:6px 0 0;padding:8px 9px;border-radius:8px;max-height:170px;overflow:auto;font-size:11px;
  line-height:15px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bd-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-bd-badge]{font-size:11px;padding:2px 7px;border-radius:6px;white-space:nowrap;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bd-badge][data-live]{background:rgba(34,197,94,.16);color:#22c55e;}
[data-bd-badge][data-warn]{background:rgba(245,158,11,.16);color:#f59e0b;}
/* ⭐ 活动流水：它刚才干了什么，一条一行，时间在左、动作在右 */
[data-bd-act]{display:flex;flex-direction:column;gap:0;max-height:280px;overflow:auto;
  border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));}
[data-bd-actline]{display:flex;gap:8px;padding:6px 9px;font-size:11px;line-height:16px;align-items:flex-start;
  border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.05));}
[data-bd-actline]:last-child{border-bottom:0;}
[data-bd-actline] time{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
/* ⚠️ 长句会撑成六七行（实测一条 200 字的旁白把流水糊掉半屏）⇒ 正常 2 行、悬停看全。
 *    用 -webkit-line-clamp 而不是 max-height：行高随字号变，固定高度会切到半行字。 */
[data-bd-actline] span{flex:1;min-width:0;word-break:break-word;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;}
[data-bd-actline]:hover span{-webkit-line-clamp:8;}
[data-bd-actline] em{flex:none;font-style:normal;font-size:10px;padding:1px 5px;border-radius:4px;
  background:rgba(96,165,250,.16);color:#60a5fa;animation:bdPulse 1.4s ease-in-out infinite;}
@keyframes bdPulse{0%,100%{opacity:1}50%{opacity:.45}}
[data-bd-actline][data-kind="call"] span{color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bd-actline][data-kind="done"] span{color:var(--dsw-alias-label-primary,inherit);}
[data-bd-actline][data-kind="fail"] span,[data-bd-actline][data-kind="budget"] span{color:#f87171;}
[data-bd-actline][data-kind="start"] span,[data-bd-actline][data-kind="resume"] span{color:#22c55e;}
[data-bd-actline][data-kind="round"] span{color:#60a5fa;font-weight:600;}
[data-bd-empty]{padding:14px;text-align:center;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
/* ⭐ 「正在想」呼吸条：模型不调工具的那几十秒，界面不能一声不吭 */
[data-bd-thinking]{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;font-size:11px;
  line-height:16px;background:rgba(96,165,250,.1);color:#93c5fd;
  border:1px solid rgba(96,165,250,.22);}
[data-bd-thinking] time{flex:none;font-variant-numeric:tabular-nums;color:rgba(147,197,253,.75);}
[data-bd-dot]{flex:none;width:7px;height:7px;border-radius:50%;background:#60a5fa;
  animation:bdBreathe 1.2s ease-in-out infinite;}
@keyframes bdBreathe{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}
/* ⭐ KPI 一排：数字大、标签小。三个格子等宽，眼睛能横向对齐
 *   （原来 4 个挤一起时，长模型名把后面全推乱了） */
[data-bd-kpi]{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;}
[data-bd-kpi] div{display:flex;flex-direction:column;gap:1px;min-width:0;}
[data-bd-kpi] b{font-size:15px;font-variant-numeric:tabular-nums;font-weight:600;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bd-kpi] span{font-size:10px;letter-spacing:.03em;color:var(--dsw-alias-label-tertiary,#9aa0a6);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* ⭐ 模型名单独一行：38 个字符的 provider/model 不可能塞进 1/4 宽度里 */
[data-bd-model]{display:flex;align-items:baseline;gap:8px;min-width:0;}
[data-bd-model] b{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
/* ⭐ 带说明的字段块：标签一行 + 说明跟在后面，比纯 note 更像表单 */
[data-bd-field]{display:flex;flex-direction:column;gap:1px;margin-top:2px;}
/* ⭐ 开关行：label 和开关之间要有虚线引导，否则开关飘在最右边像脱缰 */
[data-bd-row][data-bd-toggle]{padding:2px 0;}
[data-bd-toggle] [data-bd-sw]{margin-left:auto;}
[data-bd-learn-list]{display:flex;flex-direction:column;gap:10px;}
[data-bd-example]{margin:0;padding:8px 10px;border-left:2px solid #60a5fa;border-radius:0 7px 7px 0;
  background:rgba(96,165,250,.07);font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;}
[data-bd-source]{overflow-wrap:anywhere;}
[data-bd-settings-log]{display:flex;flex-direction:column;gap:0;max-height:260px;overflow:auto;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));border-radius:8px;}
[data-bd-logrow]{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.06));font-size:11px;line-height:16px;}
[data-bd-logrow]:last-child{border-bottom:0;}
[data-bd-logrow] time{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-logevent]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bd-logrow] [data-bd-pre]{max-height:120px;margin-top:4px;}

/* ═══════════ 🐾 桌宠（2026-10-26 桌宠化改造）═══════════
 * 挂在自建 DOM（document.body）上的常驻浮层，选择器全部带 [data-bd-pet-*] 前缀，
 * 跟设置页那套 [data-bd-*] 互不污染；控件类（按钮/输入框/开关）继续复用上面的
 * [data-bd-btn]/[data-bd-input]/[data-bd-sw]，视觉语言才是同一套。
 * 配色：柔和蓝青做鱼身（海洋），珊瑚橙只给尾鳍和强调点 —— 跟插件整体一个脾气。 */
/* ⭐ 2026-10-26 换成本体贴图后放大了一档：原图 554×561，角色本体只占下半部（脸在 ~70% 处），
   76px 的人格里五官糊成一团；128 格 + 120 贴图，桌面上一眼认得出是谁，图里那个
   「哦鲸鲸…」的小气泡也勉强能看清字。 */
/* ⚠️ 卡片/弹窗/toast 都是 [data-bd-pet] 的后代（菜单要拿 128px 的鱼盒当定位参照），
   所以凡是"手感"类的规则（grab 光标、缩放、禁选）都必须锁在 [data-bd-pet-fish] 上，
   不能落在 [data-bd-pet] 上 —— 否则菜单里的文字会被一起禁选、鼠标停在设置弹窗上鱼还在放大。 */
[data-bd-pet]{position:absolute;width:128px;height:128px;}
/* touch-action 也要锁在鱼身上：放在 [data-bd-pet] 上会连设置弹窗里的触摸滚动一起禁掉
   （沿祖先链找，卡片是它的后代） */
[data-bd-pet-fish]{position:absolute;left:4px;top:4px;width:120px;height:120px;cursor:grab;touch-action:none;
  user-select:none;-webkit-user-select:none;
  filter:drop-shadow(0 10px 20px rgba(4,24,40,.45));
  animation:bdPetFloat 3.8s ease-in-out infinite;}
[data-bd-pet][data-dragging] [data-bd-pet-fish]{cursor:grabbing;
  filter:drop-shadow(0 18px 30px rgba(4,24,40,.55));}
/* 拖动时冻住所有动画（浮沉/摆尾/光环）：一条"被抓着"的鱼不该还在装游泳 */
[data-bd-pet][data-dragging] *{animation-play-state:paused !important;}
@keyframes bdPetFloat{0%,100%{transform:translateY(0) rotate(-2.5deg)}50%{transform:translateY(-7px) rotate(2.5deg)}}
/* ⭐ 2026-10-26 换成本体贴图（554×561 的透明 PNG）：object-fit contain + 圆角阴影，
   浮沉/摆尾的动画沿用上面那条 bdPetFloat，贴图不用为动画再切图层。 */
[data-bd-pet-img]{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;
  -webkit-user-drag:none;user-select:none;-webkit-user-select:none;pointer-events:none;
  transition:transform .18s ease;
  filter:drop-shadow(0 6px 12px rgba(4,24,40,.45));}
/* ⭐ 摸一下要有反应：悬停微微放大（"我在这儿"），按下回缩（"收到"），拖起来侧一点身（"被拎住了"）。
   贴图本身没别的 transform 动画，这条 transition 不和 bdPetFloat（在外层 fish 上）打架。 */
[data-bd-pet-fish]:hover [data-bd-pet-img]{transform:scale(1.045);}
[data-bd-pet-fish]:active [data-bd-pet-img]{transform:scale(.965);}
/* 🎨 心情/需要-你小灯（2026-10-28，纯显示层）：attention 急促琥珀 > mood 四色（soul 最后一行
 *    关键词推导）。别加第二次发光 —— 鱼本体的 hover 缩放已经够戏了。 */
[data-bd-pet-mood]{position:absolute;right:10px;top:6px;width:11px;height:11px;border-radius:50%;
  border:1.5px solid rgba(255,255,255,.9);background:#9db8c8;box-shadow:0 1px 4px rgba(2,12,22,.35);
  pointer-events:none;z-index:2;}
[data-bd-pet-mood][data-mood=curious]{background:#56c8d2;box-shadow:0 0 8px rgba(86,200,210,.8);animation:bdMoodBreathe 3.2s ease-in-out infinite;}
[data-bd-pet-mood][data-mood=content]{background:#8fd08f;box-shadow:0 0 8px rgba(143,208,143,.7);}
[data-bd-pet-mood][data-mood=glum]{background:#a39ad9;box-shadow:0 0 6px rgba(163,154,217,.55);}
[data-bd-pet-mood][data-mood=attention]{background:#ffb14d;box-shadow:0 0 10px rgba(255,177,77,.9);animation:bdMoodPulse 1.6s ease-in-out infinite;}
@keyframes bdMoodBreathe{0%,100%{transform:scale(1);}50%{transform:scale(1.2);}}
@keyframes bdMoodPulse{0%,100%{transform:scale(1);}50%{transform:scale(1.35);}}
[data-bd-pet][data-dragging] [data-bd-pet-img]{transform:scale(1.02) rotate(-1.5deg);}
/* 系统里关了动效的人：浮沉/光环/泡泡全部停掉，只留静态贴图（不然会晕） */
@media (prefers-reduced-motion:reduce){
  [data-bd-pet], [data-bd-pet] *{animation:none !important;}
  [data-bd-pet-img]{transition:none;}
}
/* 状态通过菜单文字与状态卡表达，不给角色叠呼吸光圈或发光滤镜。 */
/* 🙈 藏起来之后留的那个小圆点：静态入口，不用呼吸提示打扰使用者。 */
[data-bd-pet-dot]{position:fixed;width:20px;height:20px;border-radius:50%;cursor:pointer;border:1px solid #8cb6cc;padding:0;
  background:#d7e9f2;box-shadow:0 2px 8px rgba(2,12,22,.2);opacity:.8;z-index:2147483000;}
[data-bd-pet-dot]:hover{opacity:1;background:#eef7fb;}
/* ⭐ 鱼身：渐变 + 浅肚皮；尾/背鳍/胸鳍是珊瑚橙的点缀，眼睛会眨（keyframes）
 * ⚠️ 别写成 [data-bd-pet-body] —— 那个名字已经被弹窗正文（[data-bd-pet-body]{flex:1;overflow:auto}）占了，
 *   两条规则会叠到同一个元素上：鱼身变 overflow:auto，弹窗正文反过来被 position:absolute + 49x44
 *   按扁，整个设置弹窗只剩顶上一条 tab 栏（2026-10-26 真踩过，截图验证时才发现）。 */
[data-bd-pet-torso]{position:absolute;left:13px;top:2px;width:49px;height:44px;
  border-radius:52% 62% 62% 52% / 58% 68% 68% 58%;
  background:linear-gradient(135deg,#b9e9f8 0%,#63bade 36%,#2f89bb 72%,#1d6494 100%);
  box-shadow:inset -5px -8px 11px rgba(9,50,80,.38),inset 4px 6px 9px rgba(255,255,255,.4),0 4px 10px rgba(15,60,95,.35);}
[data-bd-pet-belly]{position:absolute;left:19px;top:23px;width:36px;height:21px;border-radius:50%;pointer-events:none;
  background:linear-gradient(180deg,rgba(255,255,255,0) 0%,rgba(233,248,255,.45) 55%,rgba(233,248,255,.78) 100%);}
[data-bd-pet-tail]{position:absolute;left:-3px;top:13px;width:20px;height:24px;transform-origin:100% 50%;
  clip-path:polygon(100% 50%,4% 0,24% 50%,4% 100%);
  background:linear-gradient(90deg,#f2955c,#f97316 68%,#fb923c);
  animation:bdPetWag 1.15s ease-in-out infinite;}
@keyframes bdPetWag{0%,100%{transform:rotate(-11deg) scaleX(.9)}50%{transform:rotate(12deg) scaleX(1.1)}}
[data-bd-pet-dorsal]{position:absolute;left:31px;top:-6px;width:20px;height:13px;
  clip-path:polygon(16% 100%,52% 0,100% 100%);
  background:linear-gradient(180deg,#ffc27a,#f59e0b);}
[data-bd-pet-fin]{position:absolute;left:31px;top:39px;width:17px;height:12px;transform-origin:50% 0;
  clip-path:polygon(0 0,100% 0,50% 100%);
  background:linear-gradient(180deg,rgba(249,115,22,.85),rgba(249,115,22,.4));
  animation:bdPetFin 1.5s ease-in-out infinite;}
@keyframes bdPetFin{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(11deg)}}
[data-bd-pet-eye]{position:absolute;left:45px;top:13px;width:12px;height:12px;border-radius:50%;background:#fff;
  box-shadow:0 1px 2px rgba(6,40,64,.45);animation:bdPetBlink 4.6s infinite;}
[data-bd-pet-eye] i{position:absolute;left:5px;top:3px;width:6px;height:6px;border-radius:50%;background:#132635;
  box-shadow:inset 1px 1px 1px rgba(255,255,255,.55);}
@keyframes bdPetBlink{0%,91%,95%,100%{transform:scaleY(1)}93%{transform:scaleY(.05)}}
[data-bd-pet-mouth]{position:absolute;left:55px;top:31px;width:7px;height:4px;
  border:1.5px solid rgba(10,50,80,.55);border-top:0;border-radius:0 0 7px 7px;}
/* ⭐ 泡泡：上浮 + 消散；尺寸/偏移/时长由 React 用 CSS 变量注入，一条 keyframes 全包 */
[data-bd-pet-bubble]{position:absolute;left:57px;top:12px;width:var(--s,6px);height:var(--s,6px);border-radius:50%;
  opacity:0;pointer-events:none;
  border:1.5px solid rgba(190,230,250,.85);
  background:radial-gradient(circle at 32% 30%,rgba(255,255,255,.95),rgba(190,230,250,.25) 62%);
  animation:bdPetBubble var(--t,3.4s) ease-out var(--d,0s) forwards;}
@keyframes bdPetBubble{0%{opacity:0;transform:translate(0,0) scale(.5)}12%{opacity:.95}
  100%{opacity:0;transform:translate(var(--dx,10px),-48px) scale(1.3)}}
/* ⭐ 弹出卡片（菜单/子面板共用）：毛玻璃、圆角、阴影、缩放进场；默认在鱼上方，
 *   鱼贴顶时翻到下方（data-flip）、贴右缘时右对齐（data-align）—— 都是 JS 算好挂属性。 */
[data-bd-pet-card]{position:absolute;left:-4px;bottom:calc(100% + 14px);width:252px;border-radius:14px;overflow:hidden;
  background:rgba(16,28,40,.85);backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);
  border:1px solid rgba(255,255,255,.14);box-shadow:0 14px 44px rgba(2,12,22,.55),0 2px 8px rgba(2,12,22,.4);
  color:#e8f1f8;transform-origin:38px calc(100% + 14px);
  /* ⭐ 从鱼身上"鼓"出来：先轻微过冲再回弹（cubic-bezier 的第二段 >1 = 弹一下），
     比匀减速的 pop 更像一个气泡冒出来 —— 这是使用者要的"点击触发小气泡"的手感。 */
  animation:bdPetPop .22s cubic-bezier(.34,1.56,.64,1);}
[data-bd-pet-card][data-wide]{width:316px;}
/* ⭐ right:-4（2026-10-28）：鱼贴屏幕右缘时（box 右缘 = vw-6），right:-8 会让卡片静止时
 *   戳出视口 2px（右键菜单回归闸 top-right 场景真红过）——收成 -4 后贴缘也完整在屏内。 */
[data-bd-pet][data-align="right"] [data-bd-pet-card]{left:auto;right:-4px;transform-origin:calc(100% - 38px) calc(100% + 14px);}
[data-bd-pet][data-flip] [data-bd-pet-card]{bottom:auto;top:calc(100% + 14px);transform-origin:38px -14px;}
[data-bd-pet][data-align="right"][data-flip] [data-bd-pet-card]{transform-origin:calc(100% - 38px) -14px;}
/* 长出一小截再回弹：from 缩小 + 下移，中途 overshoot 交给 cubic-bezier 的 .34,1.56 那条曲线 */
@keyframes bdPetPop{from{opacity:0;transform:scale(.88) translateY(9px)}to{opacity:1;transform:none}}
[data-bd-pet-cardhead]{display:flex;align-items:center;gap:7px;padding:9px 12px;font-size:11px;color:#9db8c8;
  border-bottom:1px solid rgba(255,255,255,.09);}
[data-bd-pet-cardhead] b{color:#e8f1f8;font-size:12px;}
[data-bd-pet-cardhead] span{margin-left:auto;font-size:10.5px;color:#7fa0b5;}
[data-bd-pet-item]{display:flex;align-items:center;gap:9px;width:100%;padding:9px 12px;border:0;background:none;
  color:inherit;font:inherit;font-size:12.5px;cursor:pointer;text-align:left;}
[data-bd-pet-item]:hover:not(:disabled){background:rgba(125,211,252,.13);}
[data-bd-pet-item]:disabled{opacity:.55;cursor:default;}
[data-bd-pet-item] b{flex:none;font-size:15px;width:20px;text-align:center;font-weight:400;}
[data-bd-pet-item] span{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
[data-bd-pet-item] span i{font-style:normal;font-size:10.5px;color:#8fabbf;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bd-pet-sep]{height:1px;margin:3px 8px;border:0;background:rgba(255,255,255,.09);}
[data-bd-pet-spin]{flex:none;width:12px;height:12px;border-radius:50%;display:inline-block;
  border:2px solid rgba(125,211,252,.3);border-top-color:#7dd3fc;animation:bdPetSpin .7s linear infinite;}
@keyframes bdPetSpin{to{transform:rotate(360deg)}}
[data-bd-pet-pad]{padding:10px 12px;display:flex;flex-direction:column;gap:9px;}
[data-bd-pet-badge]{font-size:10.5px;padding:2px 7px;border-radius:6px;white-space:nowrap;align-self:flex-start;
  background:rgba(128,128,128,.18);color:#c9ccd1;}
[data-bd-pet-badge][data-warn]{background:rgba(245,158,11,.16);color:#f59e0b;}
[data-bd-pet-badge][data-live]{background:rgba(34,197,94,.16);color:#22c55e;}
/* 📜 日志面板：按 type 着色（start 绿 / stop 灰 / error 红 / note 蓝） */
[data-bd-pet-log]{max-height:264px;overflow:auto;display:flex;flex-direction:column;}
[data-bd-pet-logline]{display:flex;gap:7px;padding:4px 12px;font-size:11px;line-height:16px;}
[data-bd-pet-logline] time{flex:none;font-variant-numeric:tabular-nums;color:#7f9cb2;}
[data-bd-pet-logline] span{flex:1;min-width:0;word-break:break-word;}
[data-bd-pet-logline][data-t="start"] span{color:#4ade80;}
[data-bd-pet-logline][data-t="stop"] span{color:#9fb2c0;}
[data-bd-pet-logline][data-t="error"] span{color:#f87171;}
[data-bd-pet-logline][data-t="note"] span{color:#60a5fa;}
/* 🐟 状态卡 */
[data-bd-pet-status]{display:flex;flex-direction:column;padding:6px 0;}
[data-bd-pet-kv]{display:flex;gap:10px;padding:6px 12px;font-size:11.5px;align-items:baseline;}
[data-bd-pet-kv] + [data-bd-pet-kv]{border-top:1px solid rgba(255,255,255,.06);}
[data-bd-pet-kv] span{flex:none;width:92px;color:#8fabbf;}
[data-bd-pet-kv] b{flex:1;min-width:0;font-weight:600;word-break:break-all;color:#e8f1f8;}
/* ⚙️ 设置大弹窗：居中、毛玻璃、顶部 tab；卡片网格里的卡沿用 [data-bd-sec] */
[data-bd-pet-mask]{position:fixed;inset:0;background:rgba(4,12,20,.48);backdrop-filter:blur(3px);
  display:flex;align-items:center;justify-content:center;animation:bdPetFade .16s ease-out;}
@keyframes bdPetFade{from{opacity:0}to{opacity:1}}
[data-bd-pet-modal]{width:min(880px,92vw);height:min(640px,86vh);display:flex;flex-direction:column;overflow:hidden;
  border-radius:18px;background:rgba(15,27,39,.94);backdrop-filter:blur(20px) saturate(1.4);
  border:1px solid rgba(255,255,255,.15);box-shadow:0 26px 80px rgba(0,0,0,.55);color:#e8f1f8;
  animation:bdPetPop .18s ease-out;transform-origin:50% 50%;}
[data-bd-pet-tabs]{display:flex;align-items:center;gap:2px;padding:8px 10px 0;
  border-bottom:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.02);}
[data-bd-pet-tab]{padding:8px 14px;border:0;background:none;color:#9db8c8;font:inherit;font-size:12.5px;cursor:pointer;
  border-radius:9px 9px 0 0;}
[data-bd-pet-tab]:hover{color:#e8f1f8;}
[data-bd-pet-tab][data-on]{color:#fff;background:rgba(125,211,252,.15);box-shadow:inset 0 -2px 0 #38bdf8;}
[data-bd-pet-close]{margin-left:auto;width:30px;height:30px;border-radius:8px;border:0;cursor:pointer;
  background:rgba(255,255,255,.06);color:#cfe3f0;font-size:13px;}
[data-bd-pet-close]:hover{background:rgba(248,113,113,.2);color:#fca5a5;}
[data-bd-pet-body]{flex:1;overflow:auto;padding:14px 16px;}
[data-bd-pet-grid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:13px;align-items:start;}
[data-bd-pet-grid] > [data-bd-sec]{background:rgba(128,128,128,.07);}
/* tab⑤「全部设置」：整页内容塞进弹窗。收掉它自己的外框宽度上限与左右内边距，
   让卡片沿用弹窗那套 auto-fill 栅格（两块卡并排，窄屏自动单列）。 */
[data-bd-allpage]{max-width:none;}
[data-bd-allpage] > [data-bd-page]{max-width:none;padding:0;gap:13px;
  display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));align-items:start;}
[data-bd-allpage] > [data-bd-page] > [data-bd-sec],
[data-bd-allpage] > [data-bd-page] > [data-bd-row],
[data-bd-allpage] > [data-bd-page] > [data-bd-toggle]{margin:0;}
/* 整行宽的那些（横幅/流水/视频卡/它的地盘）别被栅格切成半块 */
[data-bd-allpage] > [data-bd-page] > [data-bd-msg],
[data-bd-allpage] > [data-bd-page] > [data-bd-pre]{grid-column:1/-1;}
/* ⭐ toast：桌宠的动作回执（设置页有 msg 那条常驻，浮层说完自己走） */
[data-bd-pet-toast]{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);display:flex;flex-direction:column;
  gap:8px;pointer-events:none;}
[data-bd-pet-toast] div{max-width:min(520px,86vw);padding:8px 14px;border-radius:10px;font-size:12px;line-height:17px;
  word-break:break-word;color:#e8f1f8;background:rgba(16,28,40,.92);border:1px solid rgba(125,211,252,.25);
  box-shadow:0 10px 30px rgba(2,12,22,.5);animation:bdPetPop .18s ease-out;}
[data-bd-pet-toast] div[data-tone="warn"]{border-color:rgba(245,158,11,.5);color:#fbd38d;}
[data-bd-pet-toast] div[data-tone="good"]{border-color:rgba(34,197,94,.5);color:#a7f3d0;}

/* ══════════════════════════════════════════════════════════════════════════
   ⭐ 天蓝主题（2026-10-27，使用者：右键设置里是黑的、很多字看不清 → 改天蓝）
   病因：上面那套规则把文字色写成了 var(--dsw-alias-label-*, 浅色兜底)。
   宿主若注入浅色主题变量，兜底不生效 —— 弹窗是固定深底(#0f1b27)，
   于是变成"深底 + 深字"。这里一律改成**显式浅色**，不再跟随宿主主题。
   注意：不加 !important 也能生效（同优先级、后来者胜），且不删上面任何规则 ——
   devtools 的断言与变异（[data-bd-sec] 的 border/border-radius、
   gap:10px;flex-wrap:wrap; 等）盯的是上面那些行，这里只叠加颜色。
   ══════════════════════════════════════════════════════════════════════════ */
[data-bd-page],[data-bd-allpage]{--bd-fg:#eaf6ff;--bd-fg-2:#c2d9e9;--bd-fg-3:#8fb0c7;
  --bd-line:rgba(125,211,252,.16);--bd-line-soft:rgba(125,211,252,.09);
  --bd-card:rgba(125,211,252,.055);--bd-card-2:rgba(125,211,252,.1);
  --bd-accent:#38bdf8;--bd-accent-2:#7dd3fc;color:var(--bd-fg);}
[data-bd-page] [data-bd-h],[data-bd-allpage] [data-bd-h]{color:var(--bd-fg-3);}
[data-bd-page] [data-bd-h] b,[data-bd-allpage] [data-bd-h] b{color:var(--bd-fg);}
[data-bd-page] [data-bd-label],[data-bd-allpage] [data-bd-label]{color:var(--bd-fg);}
[data-bd-page] [data-bd-note],[data-bd-allpage] [data-bd-note]{color:var(--bd-fg-3);}
[data-bd-page] [data-bd-kv],[data-bd-allpage] [data-bd-kv]{color:var(--bd-fg-2);}
[data-bd-page] [data-bd-empty],[data-bd-allpage] [data-bd-empty]{color:var(--bd-fg-3);}
[data-bd-page] [data-bd-sec],[data-bd-allpage] [data-bd-sec]{background:var(--bd-card);border-color:var(--bd-line);}
[data-bd-page] [data-bd-sub],[data-bd-allpage] [data-bd-sub]{border-left-color:var(--bd-line);}
[data-bd-page] [data-bd-sub] > [data-bd-row],[data-bd-allpage] [data-bd-sub] > [data-bd-row]{border-bottom-color:var(--bd-line-soft);}
[data-bd-page] [data-bd-input],[data-bd-allpage] [data-bd-input]{color:var(--bd-fg);border-color:var(--bd-line);background:rgba(8,22,34,.55);}
[data-bd-page] [data-bd-input]::placeholder,[data-bd-allpage] [data-bd-input]::placeholder{color:#6f8fa6;}
[data-bd-page] [data-bd-input]:focus,[data-bd-allpage] [data-bd-input]:focus{border-color:#38bdf8;
  box-shadow:0 0 0 3px rgba(56,189,248,.16);}
[data-bd-page] [data-bd-btn],[data-bd-allpage] [data-bd-btn]{color:var(--bd-fg);border-color:var(--bd-line);
  background:rgba(125,211,252,.08);}
[data-bd-page] [data-bd-btn]:hover,[data-bd-allpage] [data-bd-btn]:hover{background:rgba(125,211,252,.17);border-color:rgba(125,211,252,.3);}
[data-bd-page] [data-bd-btn][data-primary],[data-bd-allpage] [data-bd-btn][data-primary]{
  background:#38bdf8;border-color:#38bdf8;color:#04202e;font-weight:600;}
[data-bd-page] [data-bd-btn][data-primary]:hover,[data-bd-allpage] [data-bd-btn][data-primary]:hover{background:#5cc9f9;border-color:#5cc9f9;}
[data-bd-page] [data-bd-msg],[data-bd-allpage] [data-bd-msg]{color:var(--bd-fg-2);background:rgba(125,211,252,.08);}
[data-bd-page] [data-bd-badge],[data-bd-allpage] [data-bd-badge]{color:var(--bd-fg-2);background:rgba(125,211,252,.13);}
[data-bd-page] [data-bd-pre],[data-bd-allpage] [data-bd-pre]{color:var(--bd-fg-2);background:rgba(6,18,28,.6);}
[data-bd-page] [data-bd-sw],[data-bd-allpage] [data-bd-sw]{background:rgba(143,176,199,.3);}
[data-bd-page] [data-bd-sw][data-on],[data-bd-allpage] [data-bd-sw][data-on]{background:#38bdf8;}
[data-bd-page] [data-bd-actline] time,[data-bd-allpage] [data-bd-actline] time{color:var(--bd-fg-3);}
[data-bd-page] [data-bd-actline][data-kind="call"] span,[data-bd-allpage] [data-bd-actline][data-kind="call"] span{color:var(--bd-fg-2);}
[data-bd-page] [data-bd-kpi] span,[data-bd-allpage] [data-bd-kpi] span{color:var(--bd-fg-3);}
[data-bd-page] [data-bd-kpi] b,[data-bd-allpage] [data-bd-kpi] b{color:var(--bd-fg);}
/* 弹窗壳：底色压深一档、边框挑成天蓝，跟卡片同一族 */
[data-bd-pet-modal]{background:linear-gradient(175deg,rgba(11,26,38,.97),rgba(7,18,28,.98));
  border-color:rgba(125,211,252,.22);color:#eaf6ff;}
[data-bd-pet-tabs]{background:rgba(125,211,252,.05);border-bottom-color:rgba(125,211,252,.16);}
[data-bd-pet-tab]{color:#9ec0d4;}
[data-bd-pet-tab]:hover{color:#eaf6ff;background:rgba(125,211,252,.08);}
[data-bd-pet-tab][data-on]{color:#eaf6ff;background:rgba(125,211,252,.16);box-shadow:inset 0 -2px 0 #38bdf8;}
[data-bd-pet-close]{background:rgba(125,211,252,.1);color:#bfdceb;}
[data-bd-pet-close]:hover{background:rgba(248,113,113,.24);color:#ffc9c9;}
/* 分页标题（新五页每页顶上那一行：小图标 + 页名 + 一句说明） */
[data-bd-pghead]{display:flex;align-items:center;gap:9px;margin:0 0 2px;padding:0 2px;}
[data-bd-pghead] b{font-size:13.5px;font-weight:600;color:#eaf6ff;letter-spacing:.01em;}
[data-bd-pghead] span{font-size:11px;color:#8fb0c7;}
[data-bd-grid2]{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:13px;align-items:start;}
/* 「这一项现在是什么」的读数条：模型 / 轮数 / 预算，一眼扫完 */
[data-bd-readout]{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;
  padding:9px 10px;border-radius:9px;background:rgba(56,189,248,.08);border:1px solid rgba(56,189,248,.2);}
[data-bd-readout] div{display:flex;flex-direction:column;gap:2px;min-width:0;}
[data-bd-readout] b{font-size:13px;font-weight:600;color:#eaf6ff;font-variant-numeric:tabular-nums;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bd-readout] span{font-size:10px;letter-spacing:.03em;color:#8fb0c7;}

[data-bd-ico]{display:inline-block;flex:none;width:18px;height:18px;color:currentColor;vertical-align:middle;}
[data-bd-pet-item] [data-bd-ico]{align-self:center;}
/* 桌宠浮层自带颜色变量，宿主切换主题不会改变文字对比度。 */
[data-bd-pet-modal],[data-bd-pet-card]{
  --bd-fg:#163b55;--bd-fg-2:#365b75;--bd-fg-3:#4b6c83;
  --bd-line:#b8d7e9;--bd-line-soft:#d5e6f0;--bd-accent:#0879b1;
  --dsw-alias-label-primary:#163b55;--dsw-alias-label-secondary:#365b75;--dsw-alias-label-tertiary:#4b6c83;
  --dsw-alias-border-l2:#c3ddea;--dsw-alias-bg-overlay:rgba(255,255,255,.7);
  --dsw-alias-interactive-bg-hover:#d5edf9;color:var(--bd-fg);color-scheme:light;
  font-family:'Microsoft YaHei UI','Microsoft YaHei','Segoe UI',sans-serif;
}
[data-bd-pet-mask]{background:rgba(24,56,76,.28);backdrop-filter:none;padding:14px;box-sizing:border-box;}
[data-bd-pet-modal]{width:min(1000px,100%);height:min(820px,calc(100dvh - 40px));max-height:100%;
  background:#fafbf8;border:1px solid #c5d8e0;
  box-shadow:0 24px 80px rgba(16,58,87,.2);
  border-radius:18px;animation:bdSettingsIn .2s ease-out;box-sizing:border-box;}
@keyframes bdSettingsIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
[data-bd-settings-head]{display:flex;align-items:center;gap:13px;padding:21px 28px 16px;flex:none;}
[data-bd-settings-mark]{display:grid;place-items:center;width:38px;height:38px;flex:none;border-radius:50%;background:#e8f0f3;border:1px solid #d3e2e8;}
[data-bd-settings-title]{min-width:0;flex:1;}
[data-bd-settings-title] b{font-size:16px;letter-spacing:.03em;color:#163b55;}
[data-bd-settings-title] p{margin:2px 0 0;font-size:10.5px;color:#4b6c83;line-height:1.45;}
[data-bd-pet-close]{margin-left:auto;flex:none;width:32px;height:32px;display:grid;place-items:center;
  color:#365b75;background:#d7edf9;border:1px solid #bedceb;font-size:19px;}
[data-bd-pet-close]:hover{background:#fae1df;color:#973e39;}
[data-bd-pet-tabs]{padding:0 28px;gap:12px;background:transparent;flex:none;overflow-x:auto;scrollbar-width:thin;
  border-bottom:1px solid #d3e0e5;}
[data-bd-pet-tab]{display:flex;align-items:center;justify-content:center;white-space:nowrap;
  flex:none;padding:12px 4px;color:#657e89;font-size:12px;border-radius:0;
  transition:color .15s ease,background .15s ease;}
[data-bd-pet-tab]:hover{color:#1a607d;background:#f1f6f7;}
[data-bd-pet-tab][data-on]{color:#1a607d;background:transparent;box-shadow:inset 0 -2px 0 #367b96;font-weight:600;}
[data-bd-pet-body]{min-height:0;padding:25px 28px 28px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#b8cdd7 transparent;}
[data-bd-page-content]{display:flex;flex-direction:column;gap:22px;min-width:0;}
[data-bd-pghead]{padding:0 1px 2px;align-items:flex-start;gap:8px;}
[data-bd-pghead] b{color:#224b5d;font-size:17px;font-weight:600;}
[data-bd-pghead] p{color:#66808d;font-size:11px;line-height:1.7;margin:6px 0 0;}
[data-bd-pet-modal] [data-bd-ico]{display:none;}
[data-bd-pet-grid],[data-bd-grid2]{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;min-width:0;}
[data-bd-page-content]>[data-bd-pet-grid],[data-bd-pet-body]>[data-bd-pet-grid]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;align-items:start;}
[data-bd-stack]{display:flex;flex-direction:column;gap:18px;min-width:0;}
[data-bd-pet-modal] [data-bd-sec]{min-width:0;padding:21px 22px;gap:14px;border:1px solid #d8e4e8;border-radius:12px;
  background:#fffefb;box-shadow:none;color:#244a5e;}
[data-bd-pet-modal] [data-bd-sec]:hover{border-color:#bfd5df;box-shadow:none;}
[data-bd-pet-modal] [data-bd-sec][data-bd-span]{grid-column:1/-1;}
[data-bd-pet-modal] [data-bd-h]{color:#4b6c83;gap:8px;letter-spacing:.02em;flex-wrap:wrap;font-size:12px;}
[data-bd-pet-modal] [data-bd-h] b{color:#163b55;font-size:13px;}
[data-bd-pet-modal] [data-bd-label]{color:#21485f;font-size:12px;line-height:1.5;}
[data-bd-pet-modal] [data-bd-note],[data-bd-pet-modal] [data-bd-kv],
[data-bd-pet-modal] [data-bd-empty],[data-bd-pet-modal] [data-bd-kpi] span{color:#4b6c83;line-height:1.55;font-size:11px;}
[data-bd-pet-modal] [data-bd-input],[data-bd-pet-card] [data-bd-input]{color:#244a5e;background:#fffefc;border:1px solid #c4d7df;
  padding:8px 10px;max-width:100%;min-width:0;font-size:12px;line-height:1.6;border-radius:8px;
  transition:border-color .15s ease,box-shadow .15s ease;}
[data-bd-pet-modal] [data-bd-input]::placeholder{color:#5a778b;}
[data-bd-pet-modal] [data-bd-input]:focus,[data-bd-pet-card] [data-bd-input]:focus{border-color:#238fc5;outline:2px solid rgba(35,143,197,.16);outline-offset:1px;}
[data-bd-pet-modal] [data-bd-field]{gap:4px;}
[data-bd-pet-modal] textarea{resize:vertical;}
[data-bd-pet-modal] [data-bd-btn],[data-bd-pet-card] [data-bd-btn]{display:inline-flex;align-items:center;justify-content:center;gap:6px;
  color:#345e71;background:#f7faf9;border:1px solid #c5d8df;line-height:1.5;font-size:12px;max-width:100%;
  border-radius:8px;padding:8px 13px;
  transition:background .16s ease,border-color .16s ease;}
[data-bd-pet-modal] [data-bd-btn]:hover:not(:disabled),[data-bd-pet-card] [data-bd-btn]:hover:not(:disabled){
  background:#eaf2f5;border-color:#94bacb;box-shadow:none;transform:none;}
[data-bd-pet-modal] [data-bd-btn]:active:not(:disabled),[data-bd-pet-card] [data-bd-btn]:active:not(:disabled){
  transform:translateY(1px);box-shadow:none;}
[data-bd-pet-modal] [data-bd-btn][data-primary],[data-bd-pet-card] [data-bd-btn][data-primary]{
  background:#276f8b;color:#fff;border-color:#276f8b;font-weight:600;box-shadow:none;}
[data-bd-pet-modal] [data-bd-btn][data-primary]:hover:not(:disabled),[data-bd-pet-card] [data-bd-btn][data-primary]:hover:not(:disabled){
  background:#1c5c77;border-color:#1c5c77;box-shadow:none;transform:none;}
[data-bd-pet-modal] [data-bd-btn][data-primary]:active:not(:disabled),[data-bd-pet-card] [data-bd-btn][data-primary]:active:not(:disabled){
  transform:translateY(1px);box-shadow:none;}
[data-bd-pet-modal] [data-bd-btn][data-primary] [data-bd-ico]{color:#fff;background:transparent;}
[data-bd-pet-modal] [data-bd-msg]{background:#dceffb;color:#24536e;border:1px solid #b9d8eb;}
[data-bd-pet-modal] [data-bd-msg][data-warn]{background:#fff2da;border-color:#e8c98f;color:#805311;}
[data-bd-pet-modal] [data-bd-msg][data-good]{background:#e4f5ed;border-color:#b6dbcb;color:#256447;}
[data-bd-pet-modal] [data-bd-badge],[data-bd-pet-card] [data-bd-pet-badge]{background:#e1f0f9;color:#365b75;}
[data-bd-pet-modal] [data-bd-badge][data-live],[data-bd-pet-card] [data-bd-pet-badge][data-live]{background:#d9f0e5;color:#256447;}
[data-bd-pet-modal] [data-bd-badge][data-warn],[data-bd-pet-card] [data-bd-pet-badge][data-warn]{background:#fff0d6;color:#805311;}
[data-bd-pet-modal] [data-bd-pre]{color:#365b75;background:#edf6fc;border:1px solid #d2e5f0;}
[data-bd-pet-modal] [data-bd-sub]{border-color:#cbdde4;margin-left:3px;padding-left:14px;gap:12px;}
[data-bd-pet-modal] [data-bd-sub]>[data-bd-row]{border-bottom-color:#e0e9ec;padding:7px 0;}
[data-bd-pet-modal] [data-bd-sw]{background:#b3c8d1;transition:background .18s ease;}
[data-bd-pet-modal] [data-bd-sw][data-on]{background:#347c98;box-shadow:none;}
[data-bd-pet-modal] [data-bd-readout]{background:#e4f3fc;border-color:#bcddee;}
[data-bd-pet-modal] [data-bd-readout] b,[data-bd-pet-modal] [data-bd-kpi] b{color:#163b55;}
[data-bd-pet-modal] [data-bd-readout] span{color:#4b6c83;}
[data-bd-pet-modal] [data-bd-source] a{color:#086eaa;}
[data-bd-pet-modal] [data-bd-example]{background:#eef8fd;color:#365b75;border-color:#328ec2;}
[data-bd-pet-modal] [data-bd-qr] img{box-sizing:border-box;width:160px;height:160px;object-fit:contain;}
[data-bd-pet-modal] [data-bd-kv]{overflow-wrap:anywhere;}
[data-bd-pet-modal] [data-bd-actline] time{color:#4b6c83;}
[data-bd-pet-modal] [data-bd-actline][data-kind="round"] span{color:#0879b1;}
[data-bd-pet-modal] [data-bd-actline][data-kind="start"] span{color:#256447;}
[data-bd-pet-modal] [data-bd-actline][data-kind="fail"] span{color:#a63838;}
[data-bd-pet-modal] [data-bd-logrow][data-t="error"] [data-bd-logevent]{color:#a63838;}
[data-bd-pet-modal] [data-bd-logrow][data-t="start"] [data-bd-logevent]{color:#256447;}
[data-bd-pet-modal] [data-bd-logrow][data-t="note"] [data-bd-logevent]{color:#276f8b;}
[data-bd-pet-modal] [data-bd-logevent]{white-space:normal;overflow-wrap:anywhere;line-height:1.7;}
[data-bd-pet-modal] :focus-visible,[data-bd-pet-card] :focus-visible{outline:2px solid #1685bd;outline-offset:3px;}
[data-bd-pet-card]{background:#edf8ff;border-color:#b3d5e9;box-shadow:0 16px 48px rgba(18,62,91,.24);}
[data-bd-pet-cardhead]{color:#4b6c83;border-bottom-color:#c9e0ef;}
[data-bd-pet-cardhead] b,[data-bd-pet-kv] b{color:#163b55;}
[data-bd-pet-cardhead] span,[data-bd-pet-item] span i,[data-bd-pet-kv] span,[data-bd-pet-logline] time{color:#4b6c83;}
[data-bd-pet-item]:hover:not(:disabled){background:#d7eefb;}
[data-bd-pet-sep]{background:#c5deed;}
[data-bd-pet-logline][data-t="start"] span{color:#256447;}
[data-bd-pet-logline][data-t="stop"] span{color:#4b6c83;}
[data-bd-pet-logline][data-t="error"] span{color:#a63838;}
[data-bd-pet-logline][data-t="note"] span{color:#0879b1;}
[data-bd-pet-item] [data-bd-ico]{color:#4d788a;background:transparent;}
/* ═══════════ 独立 token 账本：海盐蓝 / 暖白 / 编辑式数字排版 ═══════════ */
[data-bd-ledger]{gap:20px;}
[data-bd-ledger-heading]{display:flex;align-items:center;justify-content:space-between;gap:16px;}
[data-bd-eyebrow]{font-family:'Cascadia Code','Consolas',monospace;font-size:9px;letter-spacing:.16em;color:#66818e;}
[data-bd-ledger-heading] h2{font-family:'Noto Serif SC','Source Han Serif SC','SimSun',serif;font-size:27px;line-height:1.35;font-weight:600;letter-spacing:.035em;color:#173f52;margin:7px 0 5px;}
[data-bd-ledger-heading] p{font-size:12px;color:#617882;margin:0;}
[data-bd-ledger-summary]{padding:25px 28px 18px;border:1px solid #cadde3;border-top:3px solid #216b87;border-radius:3px 3px 12px 12px;background:#fffefb;
  display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);column-gap:28px;row-gap:22px;}
[data-bd-ledger-hero]{min-width:0;}
[data-bd-ledger-label]{font-size:12px;font-weight:600;letter-spacing:.06em;color:#506f7d;}
[data-bd-ledger-number]{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;min-width:0;margin:9px 0 13px;}
[data-bd-ledger-number] b{font:600 clamp(32px,4.3vw,48px)/1.04 'Bahnschrift','DIN Alternate','Cascadia Code',sans-serif;letter-spacing:-.035em;color:#184d65;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;}
[data-bd-ledger-number]>span{font:10px/1.5 'Cascadia Code','Consolas',monospace;color:#708790;}
[data-bd-ledger-meta]{display:flex;align-items:center;flex-wrap:wrap;gap:9px;font-size:10px;color:#5c7783;}
[data-bd-ledger-hero] p{font-size:10px;color:#6b8089;margin:11px 0 0;}
[data-bd-tok-kpis]{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-self:center;border-left:1px solid #e0e9eb;padding-left:28px;}
[data-bd-tok-kpis]>div{min-width:0;}
[data-bd-tok-kpis] span{display:block;font-size:11px;color:#587381;}
[data-bd-tok-kpis] b{display:block;font:600 21px/1.35 'Bahnschrift','DIN Alternate','Cascadia Code',sans-serif;color:#254f62;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;margin:7px 0 4px;}
[data-bd-tok-kpis] small{display:block;font-size:9px;color:#75868d;line-height:1.5;}
[data-bd-ledger-budget]{grid-column:1/-1;border-top:1px solid #e3ebed;padding-top:13px;}
[data-bd-ledger-budget] [data-bd-row]{font-size:10px;color:#627b87;margin-bottom:7px;}
[data-bd-ledger-budget] b{font-variant-numeric:tabular-nums;color:#32596b;}
[data-bd-tok-bar]{height:5px;border-radius:99px;background:#e7eff2;overflow:hidden;}
[data-bd-tok-bar] i{display:block;height:100%;border-radius:99px;background:#367b96;transition:width .4s ease;}
[data-bd-ledger-budget] p{font-size:10px;color:#6d818b;line-height:1.5;margin:8px 0 0;}
[data-bd-ledger-sectionhead]{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;}
[data-bd-ledger-sectionhead] h3{font-size:13px;font-weight:600;margin:0;color:#224e63;letter-spacing:.03em;}
[data-bd-ledger-sectionhead]>span{font-size:10px;color:#6a828d;}
[data-bd-ledger-trend]{padding:0 4px;}
[data-bd-tok-days]{display:flex;gap:10px;height:76px;}
[data-bd-tok-days]>div{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:7px;height:100%;}
[data-bd-tok-daytrack]{width:100%;height:54px;display:flex;align-items:flex-end;justify-content:center;}
[data-bd-tok-days] i{display:block;width:100%;max-width:28px;border-radius:3px 3px 0 0;background:#568fa5;min-height:2px;}
[data-bd-tok-days]>div[data-zero] i{background:#dbe7eb;}
[data-bd-tok-days] span{font:9px/1 'Bahnschrift','Consolas',sans-serif;color:#718994;white-space:nowrap;}
[data-bd-tok-list]{border-top:1px solid #cbdde4;border-bottom:1px solid #cbdde4;max-height:265px;overflow:auto;scrollbar-width:thin;}
[data-bd-tokrow]{display:flex;align-items:center;gap:14px;padding:12px 4px;font-size:11px;line-height:1.5;border-bottom:1px solid #e0e9ec;}
[data-bd-tokrow]:last-child{border-bottom:0;}
[data-bd-tokrow]:hover{background:#f0f6f7;}
[data-bd-tokrow] time{flex:none;width:54px;font:10px/1.5 'Bahnschrift','Consolas',sans-serif;font-variant-numeric:tabular-nums;color:#78909a;}
[data-bd-tok-task]{flex:1;min-width:0;}
[data-bd-tok-task] strong{display:block;font-weight:500;color:#305265;}
[data-bd-tok-task]>span{display:block;margin-top:3px;font-size:9px;color:#758994;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bd-tok-amount]{text-align:right;flex:none;min-width:126px;}
[data-bd-tok-amount] em{display:block;font:600 16px/1.4 'Bahnschrift','Consolas',sans-serif;font-variant-numeric:tabular-nums;color:#225b73;font-style:normal;}
[data-bd-tok-amount] em[data-unknown]{font-family:inherit;font-size:12px;color:#8c734e;}
[data-bd-tok-amount] small{font-size:9px;color:#7b8d95;}
[data-bd-tok-chip]{flex:none;font-size:10px;font-style:normal;padding:3px 8px;border-radius:5px;background:#e9f2f5;color:#4b7485;white-space:nowrap;}
[data-bd-tok-chip][data-warn]{background:#f7efdf;color:#8a6b38;}
[data-bd-tok-empty]{padding:24px 12px;text-align:center;font-size:11px;color:#69818c;line-height:1.6;}
[data-bd-ledger-footnote]{font-size:10px;color:#758892;line-height:1.7;margin:-6px 0 0;}
[data-bd-ledger-controls]{border:1px solid #d6e3e7;border-radius:10px;background:#f1f6f6;padding:17px 18px;}
[data-bd-ledger-controls] [data-bd-row]{align-items:flex-end;}
[data-bd-ledger-controls] label{max-width:360px;}
[data-bd-pet-modal] [data-bd-danger]{background:transparent;color:#97665b;border-color:#d9c3bb;}
[data-bd-ledger-focus]{gap:9px;}
[data-bd-ledger-focus] [data-bd-ledger-heading] h2{font-size:24px;margin:4px 0;}
[data-bd-ledger-focus] [data-bd-ledger-summary]{padding:18px 24px 12px;row-gap:12px;}
[data-bd-ledger-focus] [data-bd-ledger-number]{margin:7px 0 10px;}
[data-bd-ledger-focus] [data-bd-ledger-number] b{font-size:42px;}
[data-bd-ledger-focus] [data-bd-ledger-hero] p{margin-top:7px;}
[data-bd-ledger-focus] [data-bd-ledger-budget]{padding-top:10px;}
[data-bd-ledger-focus] [data-bd-ledger-sectionhead]{margin-bottom:8px;}
[data-bd-ledger-focus] [data-bd-tok-days]{height:65px;}
[data-bd-ledger-focus] [data-bd-tok-daytrack]{height:45px;}
[data-bd-ledger-focus] [data-bd-tok-list]{max-height:none;overflow:visible;}
[data-bd-ledger-focus] [data-bd-tokrow]{padding-top:8px;padding-bottom:8px;}
[data-bd-ledger-focus] [data-bd-ledger-footnote]{margin:0;}
/* 🪞 角色头像保留为唯一主视觉，分类与卡片不再重复堆图标。 */
[data-bd-settings-mark] [data-bd-settings-avatar]{width:100%;height:100%;border-radius:inherit;object-fit:cover;display:block;}

@media(max-width:660px){
  [data-bd-pet-mask]{padding:8px;}
  [data-bd-pet-modal]{height:calc(100dvh - 16px);border-radius:15px;}
  [data-bd-settings-head]{padding:15px 14px 12px;}
  [data-bd-pet-tabs]{padding:0 9px;}
  [data-bd-pet-tab]{padding:10px 9px;}
  [data-bd-pet-body]{padding:20px 14px 24px;}
  [data-bd-page-content]>[data-bd-pet-grid],[data-bd-pet-body]>[data-bd-pet-grid]{columns:1;}
  [data-bd-pet-grid],[data-bd-grid2]{grid-template-columns:minmax(0,1fr);}
  [data-bd-pet-modal] [data-bd-sec]{padding:20px 17px;}
  [data-bd-pet-modal] [data-bd-sub]{margin-left:0;padding-left:10px;}
  [data-bd-ledger-summary]{grid-template-columns:minmax(0,1fr);padding:22px 18px 17px;gap:20px;}
  [data-bd-tok-kpis]{grid-template-columns:repeat(3,minmax(0,1fr));padding:17px 0 0;border-left:0;border-top:1px solid #e0e9eb;gap:10px;}
  [data-bd-tok-kpis] b{font-size:17px;}
  [data-bd-ledger-heading]{align-items:flex-start;gap:10px;}
  [data-bd-ledger-heading] h2{font-size:24px;}
  [data-bd-ledger-heading] [data-bd-btn]{padding:7px 10px;font-size:11px;}
  [data-bd-eyebrow]{font-size:8px;letter-spacing:.1em;}
  [data-bd-tok-days]{gap:5px;}
  [data-bd-tok-days] span{font-size:8px;}
  [data-bd-tok-days]>div:nth-child(even):not(:last-child)>span{visibility:hidden;}
  [data-bd-tokrow]{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 12px;padding:13px 1px;}
  [data-bd-tokrow] time{grid-column:1;grid-row:2;width:auto;font-size:9px;}
  [data-bd-tok-task]{grid-column:1;grid-row:1;}
  [data-bd-tok-task]>span{max-width:100%;}
  [data-bd-tok-amount]{grid-column:2;grid-row:1;min-width:0;}
  [data-bd-tok-amount] small{font-size:8px;}
  [data-bd-tokrow]>[data-bd-tok-chip]{grid-column:2;grid-row:2;justify-self:end;font-size:9px;}
  [data-bd-ledger-controls]{padding:18px 14px;}
}

/* Settings workbench: a quiet salt-blue index beside a warm-white workspace. */
[data-bd-pet-modal]{width:min(1080px,100%);height:min(850px,calc(100dvh - 36px));backdrop-filter:none;-webkit-backdrop-filter:none;}
[data-bd-settings-head]{padding:21px 26px;border-bottom:1px solid #dbe5e8;}
[data-bd-settings-title] b{font:600 20px/1.4 'Noto Serif SC','Source Han Serif SC','SimSun',serif;letter-spacing:.06em;}
[data-bd-settings-title] p{margin-top:4px;font-size:11px;}
[data-bd-settings-layout]{display:grid;grid-template-columns:172px minmax(0,1fr);flex:1;min-height:0;}
[data-bd-pet-tabs]{display:flex;flex-direction:column;align-items:stretch;gap:4px;padding:18px 12px;border:0;border-right:1px solid #dbe5e8;background:#f0f5f5;overflow-y:auto;min-height:0;}
[data-bd-nav-group]{font-size:9px;letter-spacing:.12em;color:#82959b;padding:13px 13px 5px;}
[data-bd-nav-group]:first-child{padding-top:0;}
[data-bd-pet-tab]{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:3px;white-space:normal;text-align:left;min-height:48px;padding:9px 13px;border-radius:8px;font-size:12px;line-height:1.4;color:#53707e;}
[data-bd-pet-tab] small{font-size:9px;font-weight:400;letter-spacing:.02em;color:#78909a;}
[data-bd-pet-tab]:hover{background:#e5edef;color:#255c73;}
[data-bd-pet-tab][data-on]{box-shadow:none;background:#dcebef;color:#20536b;}
[data-bd-pet-tab][data-on] small{color:#537e8f;}
[data-bd-nav-foot]{margin-top:auto;padding:20px 13px 4px;color:#8c9b9f;font:9px/1.8 'Consolas',monospace;letter-spacing:.07em;}
[data-bd-settings-main]{display:flex;flex-direction:column;min-width:0;min-height:0;}
[data-bd-pet-body]{padding:26px;min-height:0;}
[data-bd-pghead] b{font:600 24px/1.4 'Noto Serif SC','Source Han Serif SC','SimSun',serif;letter-spacing:.035em;color:#204b5e;}
[data-bd-page-content]{gap:22px;}
[data-bd-pet-modal] [data-bd-sec]{padding:20px;gap:13px;}
[data-bd-pet-modal] [data-bd-h] b{font-size:13px;}
[data-bd-segments]{display:inline-flex;align-self:flex-start;gap:4px;padding:4px;border:1px solid #d4e1e6;border-radius:10px;background:#edf3f3;max-width:100%;}
[data-bd-segments] button{border:0;border-radius:7px;padding:8px 17px;color:#64808b;background:transparent;font:inherit;font-size:11px;cursor:pointer;}
[data-bd-segments] button[aria-pressed="true"]{background:#fffefb;color:#235d76;box-shadow:0 1px 4px #233d4a14;}
[data-bd-pet-modal] [data-bd-learn-list]{height:360px;min-height:180px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:2px 7px 2px 0;}
[data-bd-pet-modal] [data-bd-learn-list]>[data-bd-sec]{padding:17px;flex:none;background:#f9fbfa;}
[data-bd-list-empty]{display:grid;place-items:center;height:360px;min-height:180px;border:1px dashed #d6e3e6;border-radius:9px;color:#79909a;font-size:11px;}
[data-bd-pet-modal] [data-bd-settings-log],[data-bd-pet-modal] [data-bd-act]{height:clamp(240px,42vh,420px);max-height:none;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;}
[data-bd-pet-modal] [data-bd-logrow]{padding:10px 13px;border-bottom:1px solid #e4ebed;}
[data-bd-pet-modal] [data-bd-logrow]:last-child{border-bottom:0;}
[data-bd-pet-modal] [data-bd-logevent]{font-size:11px;}
[data-bd-pet-modal] [data-bd-soul]{max-height:240px;overflow:auto;overscroll-behavior:contain;}
[data-bd-advanced]{border-top:1px solid #e0e9eb;padding-top:13px;}
[data-bd-advanced]>summary,[data-bd-memory]>summary{cursor:pointer;color:#4d7384;font-size:11px;line-height:1.7;}
[data-bd-advanced]>div{display:flex;flex-direction:column;gap:13px;padding-top:15px;}
[data-bd-memory]{display:block!important;}
[data-bd-memory]>summary{font-size:13px;font-weight:600;color:#244e62;}
[data-bd-memory][open]>summary{margin-bottom:18px;}
[data-bd-memory]>[data-bd-pet-grid]{margin:16px 0;}
[data-bd-memory]>[data-bd-pet-grid]>[data-bd-sec]{padding:12px!important;gap:9px!important;}
[data-bd-memory]>[data-bd-note]{margin-top:10px;}
[data-bd-pet-card]{background:#fafcf9;border-color:#ccdde4;backdrop-filter:none;-webkit-backdrop-filter:none;}
[data-bd-pet-card][data-bd-menu]{width:238px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;}
[data-bd-menu] [data-bd-pet-cardhead]{padding:13px 15px;color:#748a95;}
[data-bd-menu] [data-bd-pet-item]{padding:10px 15px;gap:12px;font-size:12px;min-height:38px;}
[data-bd-menu] [data-bd-pet-item] span i{font-size:9px;margin-top:3px;}
[data-bd-menu] [data-bd-pet-cardhead] span{font-size:9px;}
[data-bd-menu] [data-bd-pet-sep]{margin:5px 14px;background:#e0e9eb;}
[data-bd-menu-token]{padding:12px 15px 14px;border-top:1px solid #dce7eb;background:#eef4f4;}
[data-bd-menu-token]>div{display:flex;justify-content:space-between;align-items:baseline;gap:12px;}
[data-bd-menu-token] span{font-size:10px;color:#65818d;}
[data-bd-menu-token] b{font:600 17px/1.3 'Bahnschrift','Consolas',sans-serif;color:#265970;font-variant-numeric:tabular-nums;}
[data-bd-menu-token] small{display:block;margin-top:4px;font-size:9px;line-height:1.5;color:#7a9199;}
[data-bd-menu-attention]{display:block;padding:6px 8px;margin-bottom:6px;border-radius:8px;background:#fff0d6;color:#805311;font-size:10.5px;line-height:1.5;}
@media(max-width:760px){
 [data-bd-settings-layout]{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);}
 [data-bd-pet-tabs]{flex-direction:row;gap:5px;padding:7px 12px;overflow-x:auto;overflow-y:hidden;border-right:0;border-bottom:1px solid #dbe5e8;}
 [data-bd-nav-group],[data-bd-nav-foot],[data-bd-pet-tab] small{display:none;}
 [data-bd-pet-tab]{min-height:34px;padding:8px 11px;white-space:nowrap;font-size:11px;}
 [data-bd-pet-body]{padding:22px 18px;}
 [data-bd-pghead] b{font-size:22px;}
 [data-bd-pghead] p{font-size:10px;}
}
@media(max-width:660px){
 [data-bd-page-content]>[data-bd-pet-grid],[data-bd-pet-body]>[data-bd-pet-grid]{grid-template-columns:minmax(0,1fr);}
 [data-bd-settings-head]{padding:15px 18px;}
 [data-bd-settings-title] b{font-size:18px;}
 [data-bd-pet-modal] [data-bd-learn-list],[data-bd-list-empty]{height:320px;}
 [data-bd-pet-modal] [data-bd-sec]{padding:18px 16px;}
}

/* Aligned rows keep the four daily cards on a shared baseline. */
[data-bd-page-content]>[data-bd-basic-grid]{align-items:stretch;}
[data-bd-basic-grid]>[data-bd-sec]{height:auto;box-sizing:border-box;}
[data-bd-basic-grid]>[data-bd-sec]>[data-bd-row]:last-child{margin-top:auto;padding-top:3px;}
[data-bd-basic-grid]>[data-bd-basic-card="pet"]{align-self:start;}
[data-bd-basic-grid]>[data-bd-basic-card="pet"]>[data-bd-row]:last-child{margin-top:0;padding-top:0;}
[data-bd-basic-grid]>[data-bd-sec]>textarea{height:132px;min-height:132px;}
[data-bd-basic-grid]>[data-bd-sec]:first-child>textarea{flex:1;}
/* The shelf uses the same warm paper as the workbench, with bounded scrolling. */
[data-bd-sticker-controls]{align-items:stretch!important;}
[data-bd-sticker-controls]>[data-bd-sec]>[data-bd-btn]{margin-top:auto;align-self:flex-start;}
[data-bd-sticker-number]{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #e5ecee;padding:7px 0;font-size:11px;color:#4c6b7b;}
[data-bd-sticker-number]>span:last-child{display:flex;align-items:center;gap:7px;flex:none;}
[data-bd-sticker-number] [data-bd-input]{width:88px;text-align:right;}
[data-bd-sticker-number] small{color:#7c909a;width:20px;font-size:10px;}
[data-bd-sticker-count]{font-size:10px;color:#738b96;font-variant-numeric:tabular-nums;}
[data-bd-sticker-list]{height:440px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;border-top:1px solid #dbe5e8;border-bottom:1px solid #dbe5e8;padding:15px 5px 15px 0;box-sizing:border-box;}
[data-bd-sticker-grid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:13px;align-items:start;}
[data-bd-sticker-item]{min-width:0;overflow:hidden;background:#f8faf7;border:1px solid #dee7e5;border-radius:9px;}
[data-bd-sticker-open]{display:block;width:100%;padding:0;border:0;background:transparent;cursor:pointer;}
[data-bd-sticker-thumb]{display:grid;place-items:center;aspect-ratio:1;overflow:hidden;background:repeating-conic-gradient(#f0f4f2 0% 25%,#fafcf9 0% 50%) 50% / 18px 18px;color:#879991;font-size:10px;}
[data-bd-sticker-thumb] img{display:block;width:100%;height:100%;object-fit:contain;}
[data-bd-sticker-caption]{display:flex;flex-direction:column;gap:5px;padding:11px 10px 8px;min-width:0;}
[data-bd-sticker-caption] b{font-size:11px;font-weight:500;color:#365b69;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-bd-sticker-caption] small{font-size:9px;color:#879892;}
[data-bd-sticker-itemfoot]{display:flex;align-items:center;gap:5px;min-height:29px;padding:0 8px 9px;font-size:9px;color:#7a8f8c;}
[data-bd-sticker-itemfoot]>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bd-pet-modal] [data-bd-sticker-itemfoot] [data-bd-btn]{font-size:9px;padding:3px 6px;color:#8a6e63;background:transparent;border-color:#decfc6;}
[data-bd-sticker-empty]{display:grid;place-items:center;height:100%;text-align:center;font-size:11px;color:#7b9095;line-height:1.8;padding:20px;box-sizing:border-box;}
[data-bd-sticker-detail]{display:grid;grid-template-columns:144px minmax(0,1fr);gap:19px;padding:17px;background:#edf4f2;border:1px solid #d1e0db;border-radius:9px;color:#44685f;}
[data-bd-sticker-detail] p{font-size:11px;line-height:1.7;overflow-wrap:anywhere;margin:8px 0;}
[data-bd-sticker-detail] [data-bd-sticker-thumb]{border-radius:7px;}
[data-bd-sticker-detail] [data-bd-grow]{overflow-wrap:anywhere;}
[data-bd-sticker-form]{display:flex;flex-direction:column;gap:14px;padding-top:14px;}
[data-bd-sticker-form]>[data-bd-btn]{align-self:flex-start;}
[data-bd-sticker-upload]{display:grid;grid-template-columns:112px minmax(0,1fr);gap:18px;align-items:start;}
[data-bd-sticker-upload-preview]{aspect-ratio:1;display:grid;place-items:center;overflow:hidden;border:1px dashed #b4cbd0;border-radius:9px;background:#f2f6f2;color:#76918f;font-size:11px;}
[data-bd-sticker-upload-preview] img{width:100%;height:100%;object-fit:contain;}
[data-bd-sticker-upload-fields]{display:flex;flex-direction:column;gap:12px;min-width:0;}
[data-bd-sticker-upload-fields] input[type="file"]{width:100%;box-sizing:border-box;font-size:11px;}
[data-bd-sticker-upload-fields] input[type="file"]::file-selector-button{border:1px solid #c5d8df;border-radius:6px;background:#f7faf9;color:#345e71;padding:6px 9px;margin-right:9px;cursor:pointer;}
[data-bd-sticker-fileinfo]{color:#527a78;overflow-wrap:anywhere;font-size:11px;line-height:1.7;}
@media(max-width:500px){[data-bd-sticker-upload]{grid-template-columns:minmax(0,1fr);gap:12px;}[data-bd-sticker-upload-preview]{width:88px;}}
/* Menu previews reuse the status snapshot and never issue a request on hover.
 * ⭐ 2026-10-28 重画：旧版是纸白衬线卡（Noto Serif 标题 + 打字机 eyebrow + 直角上沿），
 *    和天蓝主题的菜单/弹窗完全两个时代 —— 使用者反馈「风格明显不搭」。
 *    现在整套复用菜单卡的设计语言：#edf8ff 底、#b3d5e9 描边、14px 圆角、同一套阴影，
 *    标题/正文/虚线分隔与 [data-bd-pet-card] 同源，eyebrow 变小徽章，加一个轻轻的入场动画。 */
[data-bd-preview]{z-index:3;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:13px 15px 14px;border:1px solid #b3d5e9;border-radius:14px;background:#edf8ff;color:#244a5e;box-shadow:0 16px 48px rgba(18,62,91,.24);line-height:1.6;animation:bdPreviewIn .16s ease-out;}
@keyframes bdPreviewIn{from{opacity:0;transform:translateY(5px) scale(.98);}to{opacity:1;transform:none;}}
[data-bd-preview-eyebrow]{display:inline-flex;align-items:center;gap:4px;width:fit-content;padding:2px 9px;border-radius:999px;background:#d9edf9;color:#2f6c92;font-size:10px;letter-spacing:.05em;}
[data-bd-preview-title]{display:block;font-size:13.5px;font-weight:700;color:#163b55;margin:8px 0 9px;}
[data-bd-preview-row]{display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:6px 0;border-bottom:1px dashed #c9e2f1;font-size:12px;}
[data-bd-preview-row]>span{color:#4b6c83;flex:none;}
[data-bd-preview-row]>b{min-width:0;max-width:190px;text-align:right;overflow-wrap:anywhere;font-weight:600;color:#163b55;}
[data-bd-preview] p{font-size:11.5px;line-height:1.7;color:#4b6c83;margin:9px 0 0;overflow-wrap:anywhere;}
[data-bd-preview-line]{padding:0 0 9px;border-bottom:1px dashed #c9e2f1;color:#21485f!important;}
@media(max-width:660px){[data-bd-sticker-list]{height:360px;}[data-bd-sticker-grid]{grid-template-columns:repeat(auto-fill,minmax(116px,1fr));gap:10px;}[data-bd-sticker-detail]{grid-template-columns:90px minmax(0,1fr);gap:12px;padding:13px;}[data-bd-basic-grid]>[data-bd-sec]>textarea{flex:none!important;}}
@media(prefers-reduced-motion:reduce){[data-bd-pet-modal]{animation:none;}[data-bd-preview]{animation:none;}[data-bd-pet-mood]{animation:none;}[data-bd-tok-bar] i,[data-bd-btn],[data-bd-sw]{transition:none;}}

`

    /* ────────────── 小组件 ────────────── */

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-bd-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h('div', { 'data-bd-row': '', 'data-bd-toggle': '' },
        h('div', { 'data-bd-grow': '' },
          h('div', { 'data-bd-label': '' }, label),
          note ? h('div', { 'data-bd-note': '' }, note) : null),
        h(Switch, { on, onChange, disabled }))
    }

    /* ⭐ 2026-10-26：文本输入统一走「本地草稿 + 失焦/回车才提交」。
     * GPT-SoVITS 那四个输入框以前 value 直接绑 /pv 轮询值、每敲一键就 POST 一次 ——
     * 既违反本文件自己立的"输入框必须绑本地草稿"的规矩（轮询会把正在打的字冲掉），
     * 又让一条路径打 30 多个请求。草稿领先服务端时显示草稿；轮询带回同值后自动交回控制权。 */
    function DraftInput({ value, onCommit, width, placeholder, type = 'text', inputMode }) {
      const [draft, setDraft] = React.useState(null)
      const server = String(value ?? '')
      const shown = draft !== null && draft !== server ? draft : server
      const commit = () => {
        if (draft === null || draft === server) { if (draft !== null) setDraft(null); return }
        onCommit(draft)
        // 不清草稿：等轮询带回新值（draft === server）才交回控制权，避免提交瞬间闪回旧值
      }
      return h('input', {
        'data-bd-input': '', style: { width }, type, placeholder,
        ...(inputMode ? { inputMode } : {}),
        value: shown,
        onChange: (e) => setDraft(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } },
      })
    }

    function useStatus(intervalMs, paused = false) {
      const [st, setSt] = React.useState(null)
      // ⭐ 2026-10-19（用户报"没有开关这一项，只能让 ai 帮我开"）：读不到配置时界面只显示"读设置中…"，
      //    用户会以为是开关坏了 ✗ ⇒ 数一下连续失败次数，交给界面把话说清楚（版本太旧 / 没重启 / 读不到）
      const [fails, setFails] = React.useState(0)
      /* ⭐ rev 增量（2026-10-27）：服务端签名没变时只回一行 {unchanged:true} ——
         前端连 setState 都不做，5 秒轮询从"每趟全量 payload + 全树重渲染"变成几乎白嫖。
         ⚠️ 本地乐观更新（patch / petShow 切换）改的是 st、rev 没变 ⇒ 不会被 unchanged 那趟冲掉，
            比以前"下一次轮询拿服务端真值盖回来"更稳。 */
      const revRef = React.useRef('')
      React.useEffect(() => {
        /* ⭐ paused：父组件已经在轮同一份 /status 时（弹窗共享桌宠根的那份），这里就不再起第二条轮询 */
        if (paused) return undefined
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/status' + (revRef.current ? '?rev=' + encodeURIComponent(revRef.current) : ''))
            if (!alive) return
            if (d && d.ok) {
              setFails(0)
              if (d.unchanged) return
              if (d.rev) revRef.current = String(d.rev)
              setSt(d)
            } else setFails((n) => n + 1)
          } catch { if (alive) setFails((n) => n + 1) }
        }
        tick()
        const t = setInterval(tick, intervalMs || 5000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs, paused])
      return [st, setSt, fails]
    }

    /* 🗑 旧的全页设置 Panel 已退役（2026-10-27）：它的配置项早已搬进 PetSettingsModal，
       活动流水 / 出手节奏读数 / 判重账本行也一并搬了进来。回归断言改由 render-modal.cjs 盯弹窗本体。 */

    /* ════════════════════════════════════════════════════════════════════════
     * 🐾 桌宠（2026-10-26 桌宠化改造）
     * ============================================================================
     * 为什么不走 slots：slots 是「设置页」的地盘，桌宠是常驻浮层 —— 自己建一个 div
     * 挂到 document.body，再用 react-dom 的 root 把下面这棵树渲进去（见 mountPet）。
     * 服务端契约（index.js 已实现并 smoke 过，字段名一个字都不能差）：
     *   POST /pet/session-new {}                    → {ok,sessionId,preset} | {ok:false,error,hint}
     *   POST /pet/start {mode,sessionId?,model?,tokenBudget?}
     *                                              → 成功 {ok:true,...}；非法 mode/缺 sessionId 回 HTTP 400
     *   GET  /pet/log?n=200                         → {ok,entries:[{at,type,...}]}（时间正序）
     *   /status 新增：bgBusy（后台轮在跑）、petShow（「显示桌宠」的配置镜像）
     * ──────────────────────────────────────────────────────────────────────────── */

    const PET_POS_KEY = 'dafeiyu.pet.pos'

    /* localStorage 在隐私模式/受限环境会直接抛异常 ⇒ 读写都包一层，存不上就用默认位 */
    const petStore = {
      get(k, dflt) {
        try {
          const v = window.localStorage && window.localStorage.getItem(k)
          if (!v) return dflt
          const j = JSON.parse(v)
          return (j && typeof j === 'object') ? j : dflt
        } catch { return dflt }
      },
      set(k, v) {
        try { window.localStorage && window.localStorage.setItem(k, JSON.stringify(v)) } catch { /* 存不上就每次用默认位 */ }
      },
    }

    /* 拖动/开窗都要把鱼按回视口里：留 6px 边距，别让它半个身子探出去点不回来。
     * 2026-10-26 贴图化后是 128×128 的正方形（纯 CSS 那版是 76×64）—— 常数跟 CSS 那个
     * [data-bd-pet] 的 width/height 必须同步，否则拖到右下角会有一半垂到屏幕外。 */
    const PET_W = 128
    const PET_H = 128
    const petClamp = (p) => {
      const vw = window.innerWidth || 1280
      const vh = window.innerHeight || 800
      return {
        x: Math.max(6, Math.min(Number(p && p.x) || 0, vw - PET_W - 6)),
        y: Math.max(6, Math.min(Number(p && p.y) || 0, vh - PET_H - 6)),
      }
    }

    /* token 数用人话念：500000 → 「50 万」（桌宠那扇小窗塞不下六位数字） */
    const petFmtWan = (n) => {
      const v = Number(n) || 0
      return v > 0 ? (Math.round(v / 1000) / 10) + ' 万' : '不限'
    }

    const petFmtTime = (at) => {
      if (!at) return ''
      try {
        const d = new Date(at)
        const p = (n) => String(n).padStart(2, '0')
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
      } catch { return '' }
    }

    /** 秒数 → 「3 分 20 秒」（任务明细行用；别显示 7384 秒这种没人念得出来的数） */
    const fmtDurSec = (s) => {
      const n = Math.max(0, Math.round(Number(s) || 0))
      if (n < 60) return n + ' 秒'
      const m = Math.floor(n / 60)
      if (m < 60) return m + ' 分' + (n % 60 ? ' ' + (n % 60) + ' 秒' : '')
      return Math.floor(m / 60) + ' 小时 ' + String(m % 60).padStart(2, '0') + ' 分'
    }

    /** 毫秒 → 「1 分 32 秒」（「正在想」呼吸条用；73840ms 别念成 73840） */
    const fmtSpanMs = (ms) => fmtDurSec((Number(ms) || 0) / 1000)

    /** 🐟 吃了多少 token → 称号（2026-10-27 的纯前端小彩蛋；只管显示，不改任何行为） */
    const tokTitle = (n) => {
      const v = Number(n) || 0
      if (v <= 0) return '还没开饭'
      if (v < 100000) return '挑食小鱼苗'
      if (v < 500000) return '干饭小胖鱼'
      if (v < 2000000) return '深海干饭王'
      if (v < 5000000) return 'B站吞金兽'
      return '亚特兰蒂斯守护鲲'
    }

    /* 桌宠日志一行的人话版本（type 契约见上面注释块） */
    const petEntryText = (e) => {
      const t = String((e && e.type) || 'note')
      if (t === 'session-start') {
        return `开刷（会话 · ${(e && e.model) || '默认模型'}）`
          + ` · 预算 ${petFmtWan(e && e.tokenBudget)}`
          + (Number(e && e.maxRounds) > 0 ? ` · 最多 ${e.maxRounds} 轮` : '')
      }
      if (t === 'session-stop') return `停下 · ${(e && e.reason) || '手动'}${Number(e && e.rounds) > 0 ? ` · 共 ${e.rounds} 轮` : ''}`
      if (t === 'bg-start') return [e && e.task === 'learn-review' ? '学习审核开跑' : '后台开跑', (e && e.model) || '默认模型',
        '预算 ' + petFmtWan(e && e.tokenBudget), e && e.why ? '来源 ' + e.why : ''].filter(Boolean).join(' · ')
      if (t === 'bg-progress') {
        const stages = { 'model-start': '模型请求', 'model-done': '模型返回', 'model-error': '模型错误', 'tool-start': '工具开始', 'tool-done': '工具返回', 'tool-error': '工具错误', 'usage-unknown': '用量缺失', tool: '工具调用', diagnostic: '诊断', output: '输出' }
        const label = stages[e && e.stage] || String((e && e.stage) || '进度')
        const usage = e && e.total != null ? '已计量 ' + Number(e.total).toLocaleString('zh-CN') + ' token' : ''
        return [label, e && (e.text || e.error), e && e.model, e && e.requests != null ? e.requests + ' 次请求' : '', usage].filter(Boolean).join(' · ')
      }
      if (t === 'bg-done') {
        const reasons = { exit: '正常结束', error: '错误退出', user: '手动停止', 'time-limit': '到达时限', 'spawn-error': '启动失败', 'token-budget': '本趟预算用完', 'total-budget': '累计上限已到' }
        const reason = String((e && e.reason) || '')
        const tok = e && e.tokens
        return [e && e.task === 'learn-review' ? '学习审核结束' : '后台结束', reasons[reason] || reason,
          e && e.code != null ? '退出码 ' + e.code : '', e && e.seconds != null ? '用时 ' + e.seconds + ' 秒' : '',
          e && e.model, e && e.requests != null ? e.requests + ' 次模型请求' : '', e && e.toolCalls != null ? e.toolCalls + ' 次工具调用' : '',
          tok && tok.total != null ? '已计量 ' + Number(tok.total).toLocaleString('zh-CN') + ' token' : '',
          Number(e && e.unknownRequests) > 0 ? '另有 ' + e.unknownRequests + ' 次响应用量缺失' : '', e && e.error].filter(Boolean).join(' · ')
      }
      if (t === 'learn-review-start') return ['审核开始', e && e.model, '本批 ' + Number(e && e.count || 0) + ' 条'].filter(Boolean).join(' · ')
      if (t === 'learn-review-done') return [e && e.complete ? '本批审核完成' : '本批未全部完成', '批准 ' + Number(e && e.approved || 0), '拒绝 ' + Number(e && e.rejected || 0), '仍待审 ' + Number(e && e.remaining || 0), e && e.error, e && e.nextRetryAt ? '下次可重试 ' + petFmtTime(e.nextRetryAt) : ''].filter(Boolean).join(' · ')
      if (t === 'error') return [(e && e.error) || '未知错误', e && e.model, e && e.runId ? '任务 ' + e.runId : ''].filter(Boolean).join(' · ')
      if (e && (e.text != null || e.note != null)) return String(e.text ?? e.note)
      try { return JSON.stringify(e || {}) } catch { return String(e || '') }
    }
    /* 桌宠日志的事件名与结果分开：右键面板只显示一行，设置页可展开完整原始字段。 */
    const petEntryEvent = (e) => {
      const t = String((e && e.type) || 'note')
      return ({
        'session-start': '会话开始',
        'session-stop': '会话结束',
        'bg-start': '后台开始',
        'bg-progress': '后台进度',
        'bg-done': '后台结束',
        'learn-review-start': '学习审核',
        'learn-review-done': '审核结果',
        'schedule-start': '定时启动',
        'schedule-error': '定时错误',
        error: '错误',
        note: '记录',
      })[t] || t
    }
    const petEntrySummary = (e) => `${petEntryEvent(e)}：${petEntryText(e)}`
    const petEntryRaw = (e) => {
      try { return JSON.stringify(e || {}, null, 2) } catch { return String(e || '') }
    }
    const petEntryTone = (event) => {
      const e = event && typeof event === 'object' ? event : { type: event }
      const s = String(e.type || 'note')
      if (s === 'error' || s === 'schedule-error' || e.error || e.stage === 'model-error' || e.stage === 'tool-error' || (s === 'bg-done' && (e.reason === 'error' || e.reason === 'spawn-error' || (e.code != null && Number(e.code) !== 0)))) return 'error'
      if (s === 'session-start' || s === 'bg-start') return 'start'
      if (s === 'session-stop' || s === 'bg-done') return 'stop'
      return 'note'
    }

    /* ⭐ toast：设置页有 say()/msg 那条常驻回执；桌宠是浮层、说完就该走 ——
     *   4.6 秒自动消失，最多同时 3 条（再多就把鱼盖住了）。
     *   ⚠️ 2026-10-27：定时器收进 Set、到期自己把自己删掉 —— 以前只 push 不清，
     *      弹一晚上菜单会攒几百个死 timer 引用（量小但没意义，顺手修掉）。 */
    function useToasts() {
      const [toasts, setToasts] = React.useState([])
      const seq = React.useRef(0)
      const timers = React.useRef(new Set())
      const pushRef = React.useRef(null)
      if (!pushRef.current) pushRef.current = (text, tone) => {
        const id = ++seq.current
        setToasts((old) => old.concat([{ id, text: String(text ?? ''), tone: tone || '' }]).slice(-3))
        const timer = setTimeout(() => {
          timers.current.delete(timer)
          setToasts((old) => old.filter((t) => t.id !== id))
        }, 4600)
        timers.current.add(timer)
      }
      React.useEffect(() => () => { for (const t of timers.current) clearTimeout(t) }, [])
      return [toasts, pushRef.current]
    }

    /* 🐟 形象：本体那张透明 PNG（554×561）+ 轻微浮动 + 泡泡，不叠状态光圈。
     * ⚠️ 2026-10-26：以前是纯 CSS 拼的胖鱼（怕"多加载一张图就多一个失败点"）。
     *    现在使用者指定了本体形象图，就走后端静态路由 `/api/bili-duty/pet/image`（白名单只给 pet）。
     *    图挂了（路由不在/文件丢了）自动退回 CSS 那条鱼 —— 失败点仍然是有的，但兜住了。
     * aura 由父级按 /status 算好传进来：idle 空闲 / run 鲸鱼摸鱼在刷 / bg 后台轮 / err 没登录或读不到状态 */
    function PetFish({ aura, bubbles, title }) {
      const [imgOk, setImgOk] = React.useState(true)
      return h('div', { 'data-bd-pet-fish': '', 'data-aura': aura || 'idle', title: title || '' },
        imgOk
          ? h('img', {
            'data-bd-pet-img': '', src: PET_IMG_URL, alt: '鲸鱼摸鱼', draggable: false,
            onError: () => setImgOk(false),
          })
          /* 兜底：贴图加载失败就退回原来那条纯 CSS 的胖鱼（不带 Fragment —— 假 React 里没有） */
          : [
            h('i', { key: 'tail', 'data-bd-pet-tail': '' }),
            h('i', { key: 'dorsal', 'data-bd-pet-dorsal': '' }),
            h('i', { key: 'body', 'data-bd-pet-torso': '' }),
            h('i', { key: 'belly', 'data-bd-pet-belly': '' }),
            h('i', { key: 'fin', 'data-bd-pet-fin': '' }),
            h('i', { key: 'eye', 'data-bd-pet-eye': '' }, h('i', null)),
            h('i', { key: 'mouth', 'data-bd-pet-mouth': '' }),
          ],
        bubbles.map((b) => h('i', {
          'data-bd-pet-bubble': '', key: b.id,
          style: { '--dx': b.dx + 'px', '--s': b.s + 'px', '--t': b.t + 's', '--d': b.d + 's' },
        })))
    }

    /* 🌙 后台刷一轮…：headless 独立进程那一轮（不占对话）。模型下拉复用 /status 的
     * models 清单（拿不到就退手填，判据与设置页一致）；token 预算以「万」为单位
     * 显示与输入，提交时换算成整数。开跑走 POST /pet/start {mode:'background'}。 */
    function PetBgPanel({ st, toast, onDone }) {
      const cfg = (st && st.config) || {}
      const rows = Array.isArray(st && st.models) ? st.models : []
      const [model, setModel] = React.useState(null)   // null = 还没从配置初始化过（'' 是合法值：默认模型）
      const [wan, setWan] = React.useState(null)       // 同上；'' = 不限
      const [busy, setBusy] = React.useState(false)
      const [tail, setTail] = React.useState(null)
      const lock = React.useRef(false)                 // 防双发：state 的 busy 要等重渲染才生效，连点两下会漏
      React.useEffect(() => {
        if (model === null) setModel(String(cfg.backgroundModelId ?? cfg.modelId ?? ''))
        if (wan === null) {
          const t = Number(cfg.backgroundTokenBudget ?? cfg.tokenBudget) || 0
          setWan(t > 0 ? String(Math.round(t / 10000)) : '')
        }
      }, [cfg])
      /* 日志尾巴：后台那轮「在不在动」只能靠这本账 —— 它不进对话、也不进活动流水 */
      const tailRev = React.useRef('')
      React.useEffect(() => {
        let dead = false
        const pull = async () => {
          try {
            const r = await jget('/pet/log?n=10' + (tailRev.current ? '&rev=' + encodeURIComponent(tailRev.current) : ''))
            if (!dead && r && r.ok !== false) {
              if (r.unchanged) return         // ⭐ 没新增行就不动（省一次解析+渲染）
              if (r.rev) tailRev.current = String(r.rev)
              setTail(Array.isArray(r.entries) ? r.entries : [])
            }
          } catch { /* 下次轮询会补 */ }
        }
        pull()
        const t = setInterval(pull, 3000)
        return () => { dead = true; clearInterval(t) }
      }, [])
      const bgBusy = Boolean(st && st.bgBusy)
      const run = async () => {
        if (lock.current || busy || bgBusy) return          // 绝不双发：上一轮还活着就不再叠一轮
        lock.current = true
        setBusy(true)
        try {
          const body = { mode: 'background', tokenBudget: Math.max(0, Math.round((parseFloat(wan) || 0) * 10000)) }
          if (model) body.model = model
          const r = await jpost('/pet/start', body)
          if (r && r.ok === false) {
            toast('后台没跑起来：' + (r.error || '未知原因') + (r.hint ? ' —— ' + r.hint : ''), 'warn')
            return
          }
          if (r && r.started) {
            toast('后台那轮跑起来了 —— 几分钟，做完日志里会有回执', 'good')
            if (onDone) onDone()
          } else {
            toast('后台没跑起来：' + ((r && r.error) || '可能上一轮还没结束'), 'warn')
          }
        } catch (e) { toast('后台没跑起来：' + String(e?.message ?? e), 'warn') }
        finally { lock.current = false; setBusy(false) }
      }
      const cur = model === null ? '' : String(model)
      const extra = cur && !rows.some((m) => m.id === cur) ? [{ id: cur, label: cur + '（不在当前清单里）' }] : []
      return h('div', { 'data-bd-pet-card': '', 'data-wide': '' },
        h('div', { 'data-bd-pet-cardhead': '' }, h('b', {}, '后台刷一轮'), h('span', {}, 'headless 独立进程')),
        h('div', { 'data-bd-pet-pad': '' },
          bgBusy ? h('span', { 'data-bd-pet-badge': '', 'data-warn': '' }, '后台正跑着呢 —— 等它做完再开下一轮') : null,
          h('div', { 'data-bd-row': '' },
            h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '模型'),
            rows.length
              ? h('select', {
                'data-bd-input': '', 'data-bd-num': '', style: { width: '190px' },
                value: cur, onChange: (e) => setModel(e.target.value),
              },
              h('option', { value: '' }, '默认（跟着当前对话）'),
              extra.length ? h('option', { key: 'extra', value: extra[0].id }, extra[0].label) : null,
              rows.map((m) => h('option', { key: m.id, value: m.id }, m.label || m.id)))
              : h('input', {
                'data-bd-input': '', style: { width: '190px' }, placeholder: 'provider/model（留空 = 默认）',
                value: cur, onChange: (e) => setModel(e.target.value),
              })),
          h('div', { 'data-bd-row': '' },
            h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, 'token 预算（万 · 0 = 不限）'),
            h('input', {
              'data-bd-input': '', 'data-bd-num': '', style: { width: '88px' }, type: 'number', min: 0, step: 1,
              placeholder: '不限', value: wan === null ? '' : wan,
              onChange: (e) => setWan(e.target.value),
            })),
          h('div', { 'data-bd-note': '' }, '1 万 = 10000 token。后台预算是任务目标；实际运行时长在「设置 → 后台刷」中调整。'),
          h('div', { 'data-bd-row': '' },
            h('button', {
              'data-bd-btn': '', 'data-primary': '', disabled: busy || bgBusy, onClick: run,
            }, busy ? '开跑…' : '开跑'),
            busy ? h('i', { 'data-bd-pet-spin': '' }) : null)),
        tail && tail.length
          ? h('div', {
            'data-bd-pet-log': '',
            style: { maxHeight: '122px', borderTop: '1px solid #d8e6ee' },
          },
          tail.slice(-4).map((e, i) => h('div', { 'data-bd-pet-logline': '', 'data-t': petEntryTone(e), key: i },
            h('time', {}, petFmtTime(e && e.at)), h('span', {}, petEntrySummary(e)))))
          : null)
    }

    /* 📜 运行日志：GET /pet/log，3 秒自动刷新；type 着色（start 绿 / stop 灰 / error 红 / note 蓝）。
     * 自动滚到底，但使用者往上翻时暂停自动滚（离底 <28px 才重新粘住），不然永远翻不上去。
     * 顶部「停止鲸鱼摸鱼」复用现有 POST /feiyu {action:'stop'}（跟设置页「停一下」同一个端点）。 */
    function PetLogPanel({ toast }) {
      const [entries, setEntries] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')
      const listRef = React.useRef(null)
      const stick = React.useRef(true)
      const lock = React.useRef(false)
      const revRef = React.useRef('')
      React.useEffect(() => {
        let dead = false
        const pull = async () => {
          try {
            const r = await jget('/pet/log?n=200' + (revRef.current ? '&rev=' + encodeURIComponent(revRef.current) : ''))
            if (dead) return
            if (!r || r.ok === false) { setErr((r && r.error) || '读不到'); return }
            if (r.unchanged) return            // ⭐ 日志没新增行：不重解析、不重渲染
            if (r.rev) revRef.current = String(r.rev)
            setEntries(Array.isArray(r.entries) ? r.entries : [])
            setErr('')
          } catch (e) { if (!dead) setErr(String(e?.message ?? e)) }
        }
        pull()
        const t = setInterval(pull, 3000)
        return () => { dead = true; clearInterval(t) }
      }, [])
      React.useEffect(() => {
        const el = listRef.current
        if (el && stick.current) el.scrollTop = el.scrollHeight
      }, [entries])
      const onScroll = () => {
        const el = listRef.current
        if (!el) return
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28
      }
      const onStop = async () => {
        if (lock.current) return
        lock.current = true
        setBusy(true)
        try {
          const r = await jpost('/feiyu', { action: 'stop' })
          if (r && r.ok === false) toast('没停成：' + (r.error || r.hint || '未知原因'), 'warn')
          else toast(r && r.rounds != null ? `上岸啦～这趟一共游了 ${r.rounds} 轮。` : '它本来就没在刷。', 'good')
        } catch (e) { toast('没停成：' + String(e?.message ?? e), 'warn') }
        finally { lock.current = false; setBusy(false) }
      }
      return h('div', { 'data-bd-pet-card': '', 'data-wide': '' },
        h('div', { 'data-bd-pet-cardhead': '' },
          h('b', {}, '运行日志'),
          h('span', {}, '每 3 秒自动刷新'),
          h('button', {
            'data-bd-btn': '', 'data-sm': '', style: { marginLeft: '8px' }, disabled: busy, onClick: onStop,
          }, busy ? '停…' : '停止鲸鱼摸鱼')),
        err ? h('div', { 'data-bd-pet-pad': '' }, h('div', { 'data-bd-note': '' }, '读不到日志：' + err)) : null,
        h('div', { 'data-bd-pet-log': '', ref: listRef, onScroll },
          !entries
            ? h('div', { 'data-bd-pet-logline': '' }, h('span', {}, '正在读…'))
            : entries.length === 0
              ? h('div', { 'data-bd-pet-logline': '' }, h('span', {}, '还没动静 —— 开一次会话或跑一轮后台，这儿就会一条条记下来。'))
              : entries.map((e, i) => h('div', { 'data-bd-pet-logline': '', 'data-t': petEntryTone(e), key: i },
                h('time', {}, petFmtTime(e && e.at)), h('span', {}, petEntrySummary(e))))))
    }

    /* 🐟 状态卡：字段全部来自 /status（feiyu 激活/轮次/今日挑选/本轮 token、bgBusy、loggedIn） */
    function PetStatusCard({ st, fails }) {
      const fy = (st && st.feiyu) || {}
      const tok = fy.tokens || {}
      const budget = Number(tok.budget) || 0
      const measured = tok.thisRun !== null && tok.thisRun !== undefined && tok.thisRun !== ''
        && !tok.tokensUnknown && Number.isFinite(Number(tok.thisRun)) && Number(tok.thisRun) >= 0
      const used = measured ? Number(tok.thisRun) : null
      const left = !measured ? null : tok.left != null
        ? Math.max(0, Number(tok.left) || 0)
        : (budget > 0 ? Math.max(0, budget - used) : null)
      const fmtTok = (n) => (Number(n) || 0).toLocaleString()
      const rows = [
        ['在刷与否', fy.active ? '在刷～' : '歇着'],
        ['第几轮', fy.goal && fy.goal.rounds != null ? `${fy.goal.rounds} / ${fy.goal.maxRounds || '?'} 轮` : fy.source === 'manual' ? '手动刷站' : '—'],
        ['今天挑了几条', `${Number(fy.pickedToday ?? (st && st.pickedToday) ?? 0)} / ${Number(st && st.config && st.config.perDay) || 0}`],
        ['今天发了几条说说', `${Number(fy.momentsToday ?? 0)} / ${Number(fy.momentPerDay ?? 0)}`],
        ['这轮烧的 token', !measured ? '未计量' : budget > 0
          ? `${used.toLocaleString()} / ${budget.toLocaleString()}${left != null ? `（剩 ${left.toLocaleString()}）` : ''}`
          : `${used.toLocaleString()} / 不限`],
        ['今天烧的 token', fmtTok(st && st.tokensToday)],
        ['一共烧的 token', fmtTok(st && st.tokensTotal) + (Number(st && st.tokensTotal) > 0 ? '（' + tokTitle(st && st.tokensTotal) + '）' : '')],
        ['后台轮', st ? (st.bgBusy ? '跑着呢' : '闲着') : '—'],
        ['登录', st ? (st.loggedIn ? '已登录' : '没登录') : (fails >= 3 ? '读不到状态' : '读取中…')],
        ['在用模型', String(fy.modelActive || fy.model || (st && st.modelNow) || '—')],
      ]
      return h('div', { 'data-bd-pet-card': '' },
        h('div', { 'data-bd-pet-cardhead': '' }, h('b', {}, '状态卡'),
          h('span', {}, '每 5 秒刷新' + (Number(st && st.activeDays) > 0 ? ' · 连着干活 ' + st.activeDays + ' 天' : ''))),
        h('div', { 'data-bd-pet-status': '' },
          rows.map(([k, v]) => h('div', { 'data-bd-pet-kv': '', key: k }, h('span', {}, k), h('b', {}, v)))))
    }

    /* 🪞 弹窗头像：角色立绘的脸部特写（/pet/image?name=face，服务端白名单路由）。
       图挂了（路由不在/文件丢了）自动退回原来的线条图标，不留破图框。 */
    // Read the selected workspace without accepting client-provided permissions.
    function newSessionContext(ctx) {
      try {
        const workspace = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
        const sourceSessionId = workspace?.selection?.getSnapshot?.()?.sessionId
        const items = workspace?.workspaces?.list?.getSnapshot?.()?.items || []
        const owner = sourceSessionId ? items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(sourceSessionId)) : null
        return { ...(sourceSessionId ? { sourceSessionId } : {}), ...(owner?.workspaceId ? { workspaceId: owner.workspaceId } : {}) }
      } catch { return {} }
    }
    function PetIcon({ name }) {
      const paths = {
        play: ['M8 5l11 7-11 7z'], moon: ['M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13z'],
        list: ['M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01'],
        gear: ['M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
        pulse: ['M3 12h4l3-8 4 16 3-8h4'], hide: ['M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.4 5.3A10.2 10.2 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.7M6.2 6.2A22 22 0 0 0 2 12s4 7 10 7a10.3 10.3 0 0 0 5-1.3'],
        sliders: ['M4 7h16M4 17h16M8 4v6M16 14v6'], spark: ['M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z'],
        film: ['M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 16h4M16 8h4M16 16h4'],
        chip: ['M7 7h10v10H7zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4'],
        dots: ['M5 12h.01M12 12h.01M19 12h.01'], key: ['M14 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0M13 10l8 8M17 14l-2 2M20 17l-2 2'],
      }
      return h('svg', { 'data-bd-ico': name, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        ...(paths[name] || paths.list).map((d, i) => h('path', { key: i, d })))
    }

    function SettingsAvatar() {
      const [imgOk, setImgOk] = React.useState(true)
      if (!imgOk) return h(PetIcon, { name: 'sliders' })
      return h('div', { 'data-bd-settings-mark': '', 'aria-hidden': true },
        h('img', { 'data-bd-settings-avatar': '', src: PET_AVATAR_URL, alt: '', draggable: false, onError: () => setImgOk(false) }))
    }

    /* ⭐ 设置大弹窗（2026-10-26 桌宠化改造）：从桌宠 ⚙️ 进来的居中弹窗。
     * 九项侧栏，运行方式与日志各有内部分段；图库、学习与视频按所在页读取；
     * 端点与保存语义与旧设置页一致（/config、/feiyu、/pv、/login/*、/install*、/run）。
     * ⭐ 2026-10-27：旧的全页 Panel 已退役删掉 —— 它独有过的活动流水、出手节奏读数、
     *    判重账本概览、一键诊断都搬进了这张弹窗；弹窗现在是设置的**唯一**入口，
     *    回归断言由 devtools/render-modal.cjs 盯（debugParts 只剩 PetSettingsModal / PetRoot / PetFish）。 */
function PetOtherSettings({ view = 'environment', st, setSt, busy, setBusy, say, patch, login, loginState, loginTone, onLoginStart, onInstall, onCheck, onInstallAsr, copyText, sw }) {
  const cfg = (st && st.config) || {}
  const [asrModelDraft, setAsrModelDraft] = React.useState(null)
  const [pythonPathDraft, setPythonPathDraft] = React.useState(null)
  const [mirrorDirDraft, setMirrorDirDraft] = React.useState(null)
  const [learnState, setLearnState] = React.useState('pending')
  const [learnKind, setLearnKind] = React.useState('')
  const [learnFilter, setLearnFilter] = React.useState('')
  const [learnOffset, setLearnOffset] = React.useState(0)
  const [learnQ, setLearnQ] = React.useState(null)
  const [learnError, setLearnError] = React.useState('')
  const [learnBusy, setLearnBusy] = React.useState({})
  const [learnRefresh, setLearnRefresh] = React.useState(0)
  const [mirrorNote, setMirrorNote] = React.useState('')
  const [soulBusy, setSoulBusy] = React.useState('')
  const alive = React.useRef(true)
  const learnInFlight = React.useRef(new Set())
  const learnPulling = React.useRef(false)
  const learnRequest = React.useRef(0)
     const [reviewModelDraft, setReviewModelDraft] = React.useState(null)
   const [reviewBatchDraft, setReviewBatchDraft] = React.useState(null)
   const [reviewMinutesDraft, setReviewMinutesDraft] = React.useState(null)
   const [reviewBudgetDraft, setReviewBudgetDraft] = React.useState(null)
   const learnViewRef = React.useRef(null)

  React.useEffect(() => {
    if (asrModelDraft === null) setAsrModelDraft(String(cfg.asrModel || 'small'))
    if (pythonPathDraft === null) setPythonPathDraft(String(cfg.pythonPath || 'python'))
    if (mirrorDirDraft === null) setMirrorDirDraft(String(cfg.mirrorDir || ''))
     if (reviewModelDraft === null) setReviewModelDraft(String(cfg.learnReviewModelId || ''))
     if (reviewBatchDraft === null) setReviewBatchDraft(String(cfg.learnReviewBatchSize ?? 20))
     if (reviewMinutesDraft === null) setReviewMinutesDraft(String(cfg.learnReviewMinutes ?? 10))
     if (reviewBudgetDraft === null) setReviewBudgetDraft(String(cfg.learnReviewTokenBudget ?? 12000))
  }, [cfg, asrModelDraft, pythonPathDraft, mirrorDirDraft, reviewModelDraft, reviewBatchDraft, reviewMinutesDraft, reviewBudgetDraft])

  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      learnRequest.current += 1
      learnInFlight.current.clear()
    }
  }, [])

  const learnView = {
    state: learnState,
    kind: learnKind,
    filter: learnFilter,
    limit: 20,
    offset: learnOffset,
  }
  learnViewRef.current = learnView

  React.useEffect(() => {
    if (view !== 'learning') return
    let dead = false
    let timer = null
    const queryView = { ...learnView }
    const request = async () => {
      if (dead || !alive.current || learnInFlight.current.size || learnPulling.current) return
      const seq = ++learnRequest.current
      learnPulling.current = true
      const query = '?state=' + encodeURIComponent(queryView.state)
        + '&kind=' + encodeURIComponent(queryView.kind)
        + '&filter=' + encodeURIComponent(queryView.filter)
        + '&limit=' + queryView.limit + '&offset=' + queryView.offset
      try {
        const r = await jget('/learn' + query)
        if (!r || r.ok === false) throw new Error((r && r.error) || '读学习记录失败')
        const current = learnViewRef.current || {}
        const same = current.state === queryView.state && current.kind === queryView.kind
          && current.filter === queryView.filter && Number(current.offset) === Number(queryView.offset)
        if (!dead && alive.current && seq === learnRequest.current && same && !learnInFlight.current.size) {
          setLearnQ(r)
          setLearnError('')
        }
      } catch (e) {
        if (!dead && alive.current && seq === learnRequest.current) setLearnError(String(e && e.message || e))
      } finally {
        learnPulling.current = false
      }
    }
    request()
    timer = setInterval(request, 15000)
    return () => {
      dead = true
      learnRequest.current += 1
      if (timer) clearInterval(timer)
    }
  }, [view, learnState, learnKind, learnFilter, learnOffset, learnRefresh])

  const icon = (name) => h(PetIcon, { name })
  const sectionHead = (_name, title, extra) => h('div', { 'data-bd-h': '' }, h('b', {}, title), extra || null)
  const safeSay = (text, tone) => { if (typeof say === 'function') say(String(text || ''), tone) }
  const check = (r, fallback) => {
    if (!r || r.ok === false) throw new Error((r && r.error) || fallback)
    return r
  }
  const readSwitch = (key) => typeof sw === 'function' ? Boolean(sw(key)) : Boolean(cfg[key])
  const formatTime = (value) => {
    if (!value) return ''
    try {
      const d = new Date(value)
      if (Number.isNaN(d.getTime())) return String(value)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    } catch { return String(value) }
  }
  const switchControl = (on, disabled, onChange) => h('button', {
    'data-bd-sw': '', 'data-on': on ? '' : undefined, disabled: Boolean(disabled),
    type: 'button', 'aria-pressed': Boolean(on), onClick: () => onChange(!on),
  }, h('i', {}))
  const saveConfig = async (values, label) => {
    try {
      const result = await patch(values, label)
      if (result === false) throw new Error(label + '没有保存成功')
      return true
    } catch (e) {
      safeSay(String(e && e.message || e), 'warn')
      return false
    }
  }

  const clearSoul = async (section) => {
    const label = (SOUL_SECTION_LABELS || []).find((x) => x[0] === section)
    const title = label ? label[1] : section
    if (typeof window !== 'undefined' && typeof window.confirm === 'function'
      && !window.confirm(`清空「${title}」这一节？\n\n只清空这一节，其他内容保留。`)) return
    if (soulBusy) return
    setSoulBusy(section)
    setBusy('soul')
    try {
      const r = check(await jpost('/soul', { section }), '清除 soul 失败')
      if (alive.current) {
        setSt((old) => ({ ...old, soul: r }))
        safeSay(`「${title}」已清空`, 'good')
      }
    } catch (e) {
      if (alive.current) safeSay(String(e && e.message || e), 'warn')
    } finally {
      if (alive.current) { setSoulBusy(''); setBusy('') }
    }
  }

  const sameLearnView = (view) => {
    const now = learnViewRef.current || {}
    return now.state === view.state && now.kind === view.kind && now.filter === view.filter
      && Number(now.offset) === Number(view.offset)
  }
  const decideLearn = async (id, decision) => {
    const key = String(id || '')
    if (!key || learnInFlight.current.has(key)) return
    const view = { ...(learnViewRef.current || learnView) }
    learnInFlight.current.add(key)
    setLearnBusy((old) => ({ ...old, [key]: true }))
    try {
      const r = check(await jpost('/learn', { decision, id: key, ...view }), '学习队列操作失败')
      if (!alive.current) return
      if (sameLearnView(view)) setLearnQ(r)
      setLearnError('')
      const text = decision === 'approve' ? '已批准，这条内容会作为后续参考'
        : decision === 'reject' ? '已拒绝，记录仍保留在审计历史中' : '已忘掉，这条学习已撤销'
      safeSay(text, 'good')
    } catch (e) {
      if (alive.current) { setLearnError(String(e && e.message || e)); safeSay(String(e && e.message || e), 'warn') }
    } finally {
      learnInFlight.current.delete(key)
      if (alive.current) {
        setLearnBusy((old) => { const next = { ...old }; delete next[key]; return next })
        setLearnRefresh((n) => n + 1)
      }
    }
  }

  const syncMirror = async () => {
    setBusy('mirror')
    try {
      const r = check(await jpost('/mirror', {}), '记录镜像同步失败')
      const m = r.mirror || {}
      const copied = Array.isArray(m.copied) ? m.copied : []
      setMirrorNote(copied.length ? `已同步 ${copied.length} 个文件：${copied.join('、')}` : '没有变化，不需要重复复制')
      if (alive.current && m && typeof m === 'object') setSt((old) => ({ ...old, mirror: { ...(old.mirror || {}), ...m } }))
    } catch (e) {
      setMirrorNote('同步失败：' + String(e && e.message || e))
    } finally { setBusy('') }
  }
  const openMirror = async () => {
    setBusy('mirror-open')
    try {
      const r = check(await jpost('/open', { what: 'mirror' }), '打开记录镜像失败')
      safeSay('已请求系统打开记录镜像目录：' + (r.opened || r.dir || ''), 'good')
    } catch (e) { safeSay(String(e && e.message || e), 'warn') }
    finally { setBusy('') }
  }
  const openFolder = async (what, label) => {
    setBusy('open-' + what)
    try {
      const r = check(await jpost('/open', { what }), '打开' + label + '失败')
      safeSay('已请求系统打开' + label + '：' + (r.opened || r.dir || ''), 'good')
    } catch (e) { safeSay(String(e && e.message || e), 'warn') }
    finally { setBusy('') }
  }
  const verifySpeech = async () => {
    setBusy('verify')
    try {
      const r = check(await jpost('/verify', {}), '复核发言失败')
      const rows = Array.isArray(r.checked) ? r.checked : []
      const visible = rows.filter((x) => x && x.visible === true).length
      safeSay(rows.length ? `复核 ${rows.length} 条发言：公开可见 ${visible} 条，其余可能仍在审核` : (r.text || '没有需要复核的发言'), rows.length && !visible ? 'warn' : 'good')
    } catch (e) { safeSay(String(e && e.message || e), 'warn') }
    finally { setBusy('') }
  }

  /* 🩺 一键诊断（2026-10-27）：把版本/环境/最近错误/日志尾部拼成一段文本复制走。
   * 出问题让使用者点一下、把剪贴板贴过来 —— 比教人翻 duty.log 有用一个量级。 */
  const onDiag = async () => {
    setBusy('diag')
    try {
      const r = check(await jget('/diag'), '诊断包没取到')
      const text = String(r.text || '')
      try {
        await navigator.clipboard.writeText(text)
        safeSay(`诊断包已复制到剪贴板（${text.length} 字）—— 直接去粘贴就行；凭证不在里面，可以放心贴`, 'good')
      } catch {
        try { console.log('[dsh-deepmoyu] 诊断包\n' + text) } catch { /* 无所谓 */ }
        safeSay(`剪贴板没复制上 —— 诊断包（${text.length} 字）已经打到浏览器控制台（F12）里，从那儿复制`, 'warn')
      }
    } catch (e) { safeSay(String(e && e.message || e), 'warn') }
    finally { setBusy('') }
  }

  const so = st && st.soul
  const filled = so && Array.isArray(so.filled) ? so.filled : []
  const soulCard = h('details', { 'data-bd-sec': '', 'data-bd-span': '2', 'data-bd-memory': '' },
    h('summary', {}, 'soul · 她自己的四节账'),
    h('div', { 'data-bd-note': '' }, so
      ? (so.empty ? '这本账目前是空的，由鲸鱼摸鱼自己在冲浪过程中记录。这里只提供逐节清除。'
        : `${Number(so.chars) || 0}/${Number(so.budget) || 900} 字${so.updatedAt ? '，上次更新 ' + formatTime(so.updatedAt) : ''}`)
      : '正在读取 soul 状态…'),
    so && so.text ? h('pre', { 'data-bd-pre': '', 'data-bd-soul': '' }, String(so.text)) : null,
    h('div', { 'data-bd-pet-grid': '' },
      ...(SOUL_SECTION_LABELS || []).map(([key, label]) => h('div', { key, 'data-bd-sec': '' },
        h('div', { 'data-bd-row': '' },
          h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, label),
          h('span', { 'data-bd-badge': '', 'data-live': filled.includes(key) ? '' : undefined }, filled.includes(key) ? '有记录' : '空')),
        h('button', {
          'data-bd-btn': '', 'data-sm': '', disabled: Boolean(busy) || soulBusy === key || !filled.includes(key),
          onClick: () => clearSoul(key),
        }, icon('spark'), soulBusy === key ? '清除中…' : '清除这一节')))),
    so && so.file ? h('div', { 'data-bd-note': '' }, '文件：' + String(so.file)) : null
  )

  const learnInfo = (st && st.learn) || {}
  const kinds = Array.isArray(learnInfo.kinds) ? learnInfo.kinds : []
  const labels = learnInfo.labels && typeof learnInfo.labels === 'object' ? learnInfo.labels : {}
  const q = learnQ && sameLearnView(learnView) ? learnQ : null
  const items = q && Array.isArray(q.items) ? q.items : []
  const sourceLinks = (one) => {
    const raw = []
    if (Array.isArray(one && one.sources)) raw.push(...one.sources)
    if (one && one.from) raw.push(String(one.from))
    const found = []
    for (const text of raw) {
      for (const bvid of String(text || '').match(/BV[0-9A-Za-z]{10}/g) || []) if (!found.includes(bvid)) found.push(bvid)
    }
    return found
  }
  const learnRows = q && items.length ? items.map((one) => {
    const stateLabel = ({ pending: '待审', approved: '已批准', rejected: '已拒绝' })[one.state] || one.state || ''
    const links = sourceLinks(one)
    const canApprove = one.state !== 'approved'
    const canReject = one.state !== 'rejected'
    const pending = Boolean(learnBusy[one.id]) || Boolean(busy)
    return h('div', { key: one.id, 'data-bd-sec': '', 'data-bd-learn-id': one.id },
      h('div', { 'data-bd-row': '' },
        h('span', { 'data-bd-badge': '' }, String(one.label || labels[one.kind] || one.kind || '未分类')),
        h('span', { 'data-bd-badge': '', 'data-live': one.state === 'approved' ? '' : undefined }, stateLabel),
        one.decidedAt ? h('span', { 'data-bd-note': '' }, '决定于 ' + formatTime(one.decidedAt)) : null,
        learnBusy[one.id] ? h('span', { 'data-bd-note': '', role: 'status' }, '处理中…') : null),
      h('div', { 'data-bd-label': '' }, String(one.text || '')),
      one.example ? h('blockquote', { 'data-bd-example': '' },
        h('span', { 'data-bd-note': '' }, '参考例句（外部数据）'), h('div', {}, String(one.example))) : null,
      one.from ? h('div', { 'data-bd-note': '', 'data-bd-source': '' },
        '来源：' + String(one.from),
        ...links.map((bvid) => h('a', { key: bvid, href: 'https://www.bilibili.com/video/' + bvid, target: '_blank', rel: 'noopener noreferrer' }, '打开 ' + bvid))) : null,
      one.why ? h('div', { 'data-bd-note': '' }, '决定理由：' + String(one.why)) : null,
      h('div', { 'data-bd-note': '' }, `审计：记录于 ${formatTime(one.at) || '未知'} · 版本 ${Number(one.version) || 1}`),
      h('div', { 'data-bd-row': '' },
        canApprove ? h('button', { 'data-bd-btn': '', 'data-sm': '', 'data-primary': '', disabled: pending, onClick: () => decideLearn(one.id, 'approve') }, icon('spark'), one.state === 'rejected' ? '重新批准' : '批准') : null,
        canReject ? h('button', { 'data-bd-btn': '', 'data-sm': '', disabled: pending, onClick: () => decideLearn(one.id, 'reject') }, icon('dots'), one.state === 'approved' ? '改为拒绝' : '拒绝') : null,
        h('button', { 'data-bd-btn': '', 'data-sm': '', disabled: pending, onClick: () => decideLearn(one.id, 'forget') }, icon('gear'), '忘记')))
  }) : null
  const learnCard = h('section', { 'data-bd-sec': '', 'data-bd-span': '2' },
    h('div', { 'data-bd-row': '' }, sectionHead('list', '学习队列'),
      h('span', { 'data-bd-note': '', 'data-bd-grow': '' }, `待审 ${Number(learnInfo.pending) || 0} · 已批准 ${Number(learnInfo.approved) || 0} · 已拒绝 ${Number(learnInfo.rejected) || 0}`)),
    /* 判重账本概览（2026-10-27 从旧设置页搬进来）：「刷过不再刷、回过不再回」记了多少得有地方看 */
    (() => {
      const sn = st && st.seen
      if (!sn) return null
      return h('div', { 'data-bd-note': '' },
        `判重账本：刷过 ${Number(sn.videos) || 0} 个视频（今天新记 ${Number(sn.videosToday) || 0} 个）· `
        + `回过 ${Number(sn.replied) || 0} 条评论 —— 同一个不会再来一遍`)
    })(),
    h('div', { 'data-bd-note': '' }, '批准后才会注入后续行为；例句、来源、决定理由和版本都保留，忘记只撤销当前记录并留下审计痕迹。'),
    h('div', { 'data-bd-row': '' },
      ...[['pending', '待审'], ['approved', '已批准'], ['rejected', '已拒绝'], ['all', '全部']].map(([value, label]) => h('button', {
        key: value, 'data-bd-btn': '', 'data-sm': '', 'data-primary': learnState === value ? '' : undefined,
        onClick: () => { setLearnState(value); setLearnOffset(0); setLearnQ(null) },
      }, label)),
      h('select', { 'data-bd-input': '', style: { width: '130px', flex: '0 1 130px' }, value: learnKind, onChange: (e) => { setLearnKind(e.target.value); setLearnOffset(0); setLearnQ(null) } },
        h('option', { value: '' }, '全部类别'), ...kinds.map((kind) => h('option', { key: kind, value: kind }, labels[kind] || kind)))),
    h('input', {
      'data-bd-input': '', value: learnFilter, maxLength: 160, placeholder: '筛正文、例句、来源或决定理由',
      'aria-label': '筛选学习记录', onChange: (e) => { setLearnFilter(e.target.value); setLearnOffset(0); setLearnQ(null) },
    }),
    learnError ? h('div', { 'data-bd-msg': '', 'data-warn': '' }, '学习记录读取失败：' + learnError) : null,
    !q ? h('div', { 'data-bd-list-empty': '', role: 'status' }, '正在读取学习记录…')
      : !items.length ? h('div', { 'data-bd-list-empty': '' }, learnFilter ? '没有匹配的学习记录' : '这个状态还没有学习记录')
        : h('div', { 'data-bd-learn-list': '', tabIndex: 0, 'aria-label': '学习记录列表' }, ...learnRows),
    q ? h('div', { 'data-bd-row' : '' },
      h('span', { 'data-bd-note': '', 'data-bd-grow': '' }, `显示 ${items.length ? learnOffset + 1 : 0}–${learnOffset + items.length} / ${q.matched == null ? items.length : q.matched} 条`),
      h('button', { 'data-bd-btn': '', 'data-sm': '', disabled: learnOffset <= 0 || Boolean(busy), onClick: () => { setLearnOffset(Math.max(0, learnOffset - 20)); setLearnQ(null) } }, '上一页'),
      h('button', { 'data-bd-btn': '', 'data-sm': '', disabled: !q.more || Boolean(busy), onClick: () => { setLearnOffset(learnOffset + 20); setLearnQ(null) } }, '下一页')) : null
  )

  const reviewStatus = (st && st.learnReview) || {}
  const reviewModels = Array.isArray(st && st.models) ? st.models : []
  const reviewCard = h('section', { 'data-bd-sec': '', 'data-bd-span': '2' },
    sectionHead('pulse', '后台自动审核'),
    h('div', { 'data-bd-row': '', 'data-bd-toggle': '' },
      h('div', { 'data-bd-grow': '' },
        h('div', { 'data-bd-label': '' }, '自动审核待审内容'),
        h('div', { 'data-bd-note': '' }, '由模型逐条判断；证据不足会拒绝或保留待审，不会代替你发 B站 内容。')),
      switchControl(readSwitch('learnAutoReview'), Boolean(busy), (v) => saveConfig({ learnAutoReview: v }, '自动审核学习队列'))),
    h('details', { 'data-bd-advanced': '' }, h('summary', {}, '模型与审核参数'), h('div', {},
    h('div', { 'data-bd-row': '' },
      h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '审核模型'),
      reviewModels.length ? h('select', { 'data-bd-input': '', value: reviewModelDraft === null ? '' : reviewModelDraft, onChange: (e) => setReviewModelDraft(e.target.value) },
        h('option', { value: '' }, '跟随后台模型'),
        reviewModelDraft && !reviewModels.some((m) => m.id === reviewModelDraft) ? h('option', { value: reviewModelDraft }, reviewModelDraft + '（清单外）') : null,
        reviewModels.map((m) => h('option', { key: m.id, value: m.id }, m.label || m.id)))
        : h('input', { 'data-bd-input': '', value: reviewModelDraft === null ? '' : reviewModelDraft, placeholder: '留空 = 跟随后台模型', onChange: (e) => setReviewModelDraft(e.target.value) })),
    h('div', { 'data-bd-row': '' },
      h('label', { 'data-bd-field': '' }, h('span', { 'data-bd-label': '' }, '每批最多'), h('input', { 'data-bd-input': '', type: 'number', min: 1, max: 50, value: reviewBatchDraft ?? '20', onChange: (e) => setReviewBatchDraft(e.target.value) })),
      h('label', { 'data-bd-field': '' }, h('span', { 'data-bd-label': '' }, '最长分钟'), h('input', { 'data-bd-input': '', type: 'number', min: 1, max: 60, value: reviewMinutesDraft ?? '10', onChange: (e) => setReviewMinutesDraft(e.target.value) })),
      h('label', { 'data-bd-field': '' }, h('span', { 'data-bd-label': '' }, 'token 预算'), h('input', { 'data-bd-input': '', type: 'number', min: 0, max: 5000000, step: 1000, value: reviewBudgetDraft ?? '12000', onChange: (e) => setReviewBudgetDraft(e.target.value) }))),
    h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: () => saveConfig({
        learnReviewModelId: String(reviewModelDraft || '').trim(),
        learnReviewBatchSize: Math.max(1, Math.min(50, Number(reviewBatchDraft) || 20)),
        learnReviewMinutes: Math.max(1, Math.min(60, Number(reviewMinutesDraft) || 10)),
        learnReviewTokenBudget: Math.max(0, Math.min(5000000, Number(reviewBudgetDraft) || 0)),
      }, '模型审核设置') }, '保存审核设置'))) ,
    h('div', { 'data-bd-row': '' },
      h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: Boolean(busy) || Boolean(reviewStatus.running) || !Number(reviewStatus.pending || learnInfo.pending), onClick: async () => {
        setBusy('learn-review')
        try {
          const r = check(await jpost('/learn/review', {}), '启动模型审核失败')
          if (r.learnReview) setSt((old) => ({ ...old, learnReview: r.learnReview }))
          safeSay(r.started ? '模型审核已开始，完成后会写入运行日志。' : (r.message || '当前没有待审核内容。'), r.started ? 'good' : '')
        } catch (e) { safeSay(String(e && e.message || e), 'warn') }
        finally { setBusy('') }
      } }, reviewStatus.running ? '审核中…' : '现在审核一批'),
      reviewStatus.running ? h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: async () => {
        setBusy('learn-review-stop')
        try { const r = check(await jpost('/learn/review', { action: 'stop' }), '停止模型审核失败'); if (r.learnReview) setSt((old) => ({ ...old, learnReview: r.learnReview })); safeSay('模型审核已请求停止。', 'good') }
        catch (e) { safeSay(String(e && e.message || e), 'warn') } finally { setBusy('') }
      } }, '停止审核') : null),
    h('div', { 'data-bd-row': '' },
      h('span', { 'data-bd-badge': '', 'data-live': reviewStatus.running ? '' : undefined }, reviewStatus.running ? '审核中' : reviewStatus.complete ? '本批完成' : reviewStatus.lastError ? '本批未完成' : '待命'),
      h('span', { 'data-bd-badge': '' }, '全部待审 ' + Number(reviewStatus.pending ?? learnInfo.pending ?? 0)),
      h('span', { 'data-bd-badge': '' }, '本批批准 ' + Number(reviewStatus.approved || 0)),
      h('span', { 'data-bd-badge': '' }, '本批拒绝 ' + Number(reviewStatus.rejected || 0)),
      reviewStatus.remaining != null ? h('span', { 'data-bd-badge': '' }, '本批剩余 ' + Number(reviewStatus.remaining)) : null),
    reviewStatus.model ? h('div', { 'data-bd-note': '' }, (reviewStatus.running ? '正在使用：' : '最近使用：') + reviewStatus.model) : null,
    reviewStatus.lastError ? h('div', { 'data-bd-msg': '', 'data-warn': '' }, '审核提示：' + reviewStatus.lastError) : null,
    !reviewStatus.running && Number(reviewStatus.nextRetryAt) > 0 ? h('div', { 'data-bd-note': '' }, '自动重试最早：' + formatTime(reviewStatus.nextRetryAt) + (reviewStatus.enabled ? '' : '（自动审核未开启）')) : null,
    h('div', { 'data-bd-note': '' }, reviewStatus.lastFinishedAt ? '上次结束：' + formatTime(reviewStatus.lastFinishedAt) : '尚未运行；打开自动审核后，下一次检查会处理待审队列。'))

  const mirror = (st && st.mirror) || {}
  const mirrorCard = h('section', { 'data-bd-sec': '' },
    sectionHead('dots', '记录镜像'),
    h('div', { 'data-bd-note': '' }, mirror.error ? '镜像出错：' + mirror.error
      : mirror.dir ? `复制到：${mirror.dir}${mirror.lastAt ? ' · 上次 ' + formatTime(mirror.lastAt) + '（' + ((mirror.lastCopied || []).length) + ' 个）' : ''}`
        : '还没有可用镜像目录；可以填写目录，或让插件从 out/digest junction 自动推断。'),
    h('div', { 'data-bd-row': '' },
      h('input', { 'data-bd-input': '', value: mirrorDirDraft === null ? '' : mirrorDirDraft, placeholder: '留空 = 自动推断镜像目录', onChange: (e) => setMirrorDirDraft(e.target.value) }),
      h('button', { 'data-bd-btn': '', 'data-sm': '', disabled: Boolean(busy), onClick: () => saveConfig({ mirrorDir: String(mirrorDirDraft || '').trim() }, '镜像目录') }, '保存目录')),
    h('div', { 'data-bd-row': '' },
      h('button', { 'data-bd-btn': '', disabled: Boolean(busy) || !mirror.dir, onClick: syncMirror }, icon('dots'), '现在同步'),
      h('button', { 'data-bd-btn': '', disabled: Boolean(busy) || !mirror.dir, onClick: openMirror }, icon('gear'), '打开目录'),
      mirror.dir ? h('button', { 'data-bd-btn': '', 'data-sm': '', disabled: Boolean(busy), onClick: () => copyText(mirror.dir) }, '复制路径') : null),
    mirrorNote ? h('div', { 'data-bd-msg': '' }, mirrorNote) : null,
    h('div', { 'data-bd-note': '' }, '镜像是给人看的脱敏快照，不会复制登录凭证。'))

  const accountCard = h('section', { 'data-bd-sec': '', 'data-bd-span': '2' },
    sectionHead('key', '账号与环境'),
    h('div', { 'data-bd-row': '' },
      h('span', { 'data-bd-badge': '', 'data-live': st && st.loggedIn ? '' : undefined }, st && st.loggedIn ? 'B站已登录' : 'B站未登录'),
      h('span', { 'data-bd-badge': '', 'data-live': st && st.venvReady ? '' : undefined }, st && st.venvReady ? '主环境就绪' : '主环境未就绪'),
      h('span', { 'data-bd-badge': '', 'data-live': st && st.dshCli && st.dshCli.ok ? '' : undefined }, st && st.dshCli && st.dshCli.ok ? 'dsh命令正常' : 'dsh命令待检查'),
      h('span', { 'data-bd-badge': '' }, 'v' + String((st && st.version) || '?'))),
    h('div', { 'data-bd-note': '' }, '首次使用先安装主依赖，再扫码登录；测一下会实际检查登录和搜索。'),
    h('div', { 'data-bd-row': '' },
      h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: onInstall }, icon('gear'), '装主依赖'),
      h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: onCheck }, icon('pulse'), '测一下'),
      h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: onLoginStart }, icon('key'), '扫码登录'),
      h('button', { 'data-bd-btn': '', disabled: Boolean(busy), title: '把版本/环境/最近错误/日志尾部拼成一段文本复制走 —— 出问题直接把剪贴板贴出来', onClick: onDiag }, icon('dots'), busy === 'diag' ? '打包中…' : '一键诊断')),
    login ? h('div', { 'data-bd-qr': '' },
      login.qr ? h('img', { src: login.qr, alt: 'B站扫码登录二维码' }) : h('div', { 'data-bd-msg': '', 'data-warn': '' }, '二维码没有生成，请先安装主依赖。'),
      h('div', { 'data-bd-grow': '' },
        h('div', { 'data-bd-note': '' }, '手机 B站打开扫一扫，确认时选择记住我或长期登录。'),
        h('div', { 'data-bd-msg': '', 'data-warn': loginTone === 'warn' ? '' : undefined, 'data-good': loginTone === 'good' ? '' : undefined }, loginState || '等待扫码…'))) : null,
    loginState && !login ? h('div', { 'data-bd-msg': '', 'data-warn': loginTone === 'warn' ? '' : undefined, 'data-good': loginTone === 'good' ? '' : undefined }, loginState) : null,
    st && st.installLog ? h('div', { 'data-bd-row': '' }, h('span', { 'data-bd-note': '', 'data-bd-grow': '' }, '主依赖日志：' + st.installLog), h('button', { 'data-bd-btn': '', 'data-sm': '', onClick: () => copyText(st.installLog) }, '复制路径')) : null,
    st && st.installTail ? h('pre', { 'data-bd-pre': '' }, String(st.installTail).slice(-1800)) : null)

  const asrCard = h('section', { 'data-bd-sec': '' },
    sectionHead('gear', '本地转写与 ASR'),
    h('div', { 'data-bd-row': '', 'data-bd-toggle': '' },
      h('div', { 'data-bd-grow': '' }, h('div', { 'data-bd-label': '' }, '启用本地转写'), h('div', { 'data-bd-note': '' }, '只有视频没有字幕时才使用，会下载独立环境和 Whisper 模型。')),
      switchControl(readSwitch('transcribe'), Boolean(busy), (v) => saveConfig({ transcribe: v }, '本地转写'))),
    h('div', { 'data-bd-row': '' },
      h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, 'Whisper 模型'),
      h('select', { 'data-bd-input': '', style: { width: '140px' }, value: asrModelDraft === null ? 'small' : asrModelDraft, onChange: (e) => setAsrModelDraft(e.target.value) },
        ...['tiny', 'base', 'small', 'medium'].map((name) => h('option', { key: name, value: name }, name)))),
    h('div', { 'data-bd-row': '' },
      h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '主 Python 路径'),
      h('input', { 'data-bd-input': '', value: pythonPathDraft === null ? '' : pythonPathDraft, onChange: (e) => setPythonPathDraft(e.target.value), placeholder: 'python 或 venv/python.exe' })),
    h('div', { 'data-bd-row': '' },
      h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: () => saveConfig({ asrModel: String(asrModelDraft || 'small'), pythonPath: String(pythonPathDraft || '').trim() }, 'ASR参数') }, '保存 ASR 参数'),
      h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: onInstallAsr }, icon('gear'), st && st.asrReady ? '转写已安装' : '安装转写')),
    h('div', { 'data-bd-row': '' },
      h('span', { 'data-bd-badge': '', 'data-live': st && st.asrReady ? '' : undefined }, st && st.asrReady ? '转写环境就绪' : '转写环境未就绪'),
      h('span', { 'data-bd-badge': '', 'data-live': st && st.asrModelReady ? '' : undefined }, st && st.asrModelReady ? '模型已下载' : '模型未下载'),
      st && st.asrInstalling ? h('span', { 'data-bd-badge': '', 'data-live': '' }, '安装中') : null),
    st && st.asrLog ? h('div', { 'data-bd-row' : '' }, h('span', { 'data-bd-note': '', 'data-bd-grow': '' }, 'ASR日志：' + st.asrLog), h('button', { 'data-bd-btn': '', 'data-sm': '', onClick: () => copyText(st.asrLog) }, '复制路径')) : null,
    st && st.asrTail ? h('pre', { 'data-bd-pre': '' }, String(st.asrTail).slice(-1600)) : null)

  const groundCard = h('section', { 'data-bd-sec': '', 'data-bd-span': '2' },
    sectionHead('pulse', '它的地盘与发言复核'),
    h('div', { 'data-bd-kv': '' }, '家目录：' + String((st && st.home) || '')), 
    h('div', { 'data-bd-kv': '' }, '报告路径：' + String((st && st.report) || '')), 
    h('div', { 'data-bd-row' : '' },
      h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: () => openFolder('home', '地盘') }, icon('pulse'), '打开地盘'),
      h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: () => openFolder('out', '产物目录') }, icon('gear'), '打开产物目录'),
      st && st.home ? h('button', { 'data-bd-btn': '', 'data-sm': '', disabled: Boolean(busy), onClick: () => copyText(st.home) }, '复制地盘路径') : null,
      st && st.report ? h('button', { 'data-bd-btn': '', 'data-sm': '', disabled: Boolean(busy), onClick: () => copyText(st.report) }, '复制报告路径') : null),
    h('div', { 'data-bd-note': '' }, '这里保留的是插件运行地盘、输出路径和发言复核入口；不会打开或改写登录凭证。'))

  return h('div', { 'data-bd-page-content': '', 'data-bd-settings-page': view === 'learning' ? 'learning' : 'other' },
    h('div', { 'data-bd-pghead': '' }, h('div', {}, h('b', {}, view === 'learning' ? '学习与记忆' : '账号与环境'),
      h('p', {}, view === 'learning' ? '审核在后台进行。这里查看进度、管理记录与她的小心事。' : '登录、依赖与本地记录。环境状态集中在这里。'))),
    h('div', { 'data-bd-pet-grid': '', 'data-bd-other': '' },
      ...(view === 'learning' ? [reviewCard, learnCard, soulCard] : [accountCard, asrCard, mirrorCard, groundCard])))
}


    /* 独立账本：总量只读宿主累计数；任务明细与日图只做展示，不反推总量。 */
    function PetTokenLedger({ st, budgetDraft, setBudgetDraft, busy, saveBudget, resetTokens }) {
      const [focus, setFocus] = React.useState(false)
      const known = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0
      const fmt = (v) => known(v) ? Number(v).toLocaleString('zh-CN') : '—'
      const total = st.tokensTotal
      const today = st.tokensToday
      const cap = Number((st.config || {}).totalTokenBudget ?? st.totalTokenBudget) || 0
      const ratio = cap > 0 && known(total) ? Math.round(Number(total) / cap * 100) : null
      const rounds = Array.isArray(st.tokenRounds && st.tokenRounds.entries) ? st.tokenRounds.entries : []
      const unmetered = (r) => Boolean(r.tokensUnknown) || !r.tokens || !known(r.tokens.total)
      const unknownCount = rounds.filter(unmetered).length
      const partial = (r) => !unmetered(r) && Number(r.unknownRequests) > 0
      const partialCount = rounds.filter(partial).length
      const background = st.backgroundRun || {}
      const current = background.active ? background.usage?.total : st.feiyu?.active ? st.feiyu.tokens?.thisRun : undefined
      const currentLabel = background.active ? (background.task === 'learn-review' ? '本趟审核' : '本趟后台') : st.feiyu?.active ? '本趟会话' : '当前任务'
      const endLabels = { user: '手动结束', exit: '已结束', error: '错误退出', 'token-budget': '本趟预算用完', 'total-budget': '累计上限已到', 'time-limit': '到达时限', 'spawn-error': '启动失败' }
      const warnEnds = ['error', 'token-budget', 'total-budget', 'time-limit', 'spawn-error']
      const cols = []
      const dayValues = st.tokenDays && typeof st.tokenDays === 'object' ? st.tokenDays : {}
      for (let i = 13; i >= 0; i--) {
        const d = new Date()
        d.setDate(d.getDate() - i)
        const pad = (v) => String(v).padStart(2, '0')
        const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        cols.push({ key, label: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, value: Number(dayValues[key]) || 0 })
      }
      const dayMax = Math.max(1, ...cols.map((c) => c.value))
      const shownRounds = focus ? rounds.slice(0, 4) : rounds
      const clear = async () => {
        if (busy || typeof window.confirm !== 'function') return
        if (!window.confirm('清零累计 token 和任务明细？\n\n累计上限不会改变，此操作不可撤销。')) return
        await resetTokens()
      }
      return h('div', { 'data-bd-page-content': '', 'data-bd-settings-page': 'ledger', 'data-bd-ledger': '', 'data-bd-ledger-focus': focus ? '' : undefined },
        h('div', { 'data-bd-ledger-heading': '' },
          h('div', {}, h('span', { 'data-bd-eyebrow': '' }, 'DAFEIYU / TOKEN JOURNAL'),
            h('h2', {}, 'token 账本'), h('p', {}, '每一趟认真摸鱼，都有据可查。')),
          h('button', { 'data-bd-btn': '', type: 'button', 'aria-pressed': focus, onClick: () => setFocus((old) => !old) }, focus ? '退出截图视图' : '截图视图')),
        h('section', { 'data-bd-ledger-summary': '', 'aria-label': 'token 用量总览' },
          h('div', { 'data-bd-ledger-hero': '' },
            h('span', { 'data-bd-ledger-label': '' }, '累计用量'),
            h('div', { 'data-bd-ledger-number': '' }, h('b', { 'data-bd-ledger-total': '' }, fmt(total)), h('span', {}, 'tokens')),
            h('div', { 'data-bd-ledger-meta': '' },
              known(total) ? h('span', { 'data-bd-tok-chip': '', title: '称号只是显示，不影响行为' }, '称号 · ' + tokTitle(total)) : null,
              Number(st.activeDays) > 0 ? h('span', {}, '连着干活 ' + st.activeDays + ' 天') : null),
            h('p', {}, '已记录的真实用量，不含未计量任务。')),
          h('div', { 'data-bd-tok-kpis': '' },
            h('div', {}, h('span', {}, '今日用量'), h('b', {}, fmt(today)), h('small', {}, '本地时间 00:00 起')),
            h('div', {}, h('span', {}, currentLabel), h('b', {}, fmt(current)), h('small', {}, background.active && Number(background.unknownRequests) > 0 ? '另有 ' + background.unknownRequests + ' 次响应用量缺失' : background.active || st.feiyu?.active ? '正在记录中' : '当前没有运行任务')),
            h('div', {}, h('span', {}, '累计上限'), h('b', {}, cap > 0 ? fmt(cap) : '不限'), h('small', {}, '已保存的总闸额度'))),
          cap > 0 ? h('div', { 'data-bd-ledger-budget': '' },
            h('div', { 'data-bd-row': '' }, h('span', { 'data-bd-grow': '' }, '累计上限进度'), h('b', {}, ratio === null ? '—' : ratio + '%')),
            h('div', { 'data-bd-tok-bar': '', role: 'progressbar', 'aria-label': '累计 token 上限使用比例', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': ratio === null ? undefined : Math.min(100, ratio) },
              h('i', { style: { width: (ratio === null ? 0 : Math.min(100, ratio)) + '%' } })),
            h('p', {}, '到顶会自动暂停会话刷；后台单轮预算在「后台刷」页单独设置。')) : null),
        h('section', { 'data-bd-ledger-trend': '', 'aria-label': '最近 14 天 token 用量' },
          h('div', { 'data-bd-ledger-sectionhead': '' }, h('h3', {}, '最近 14 天'), h('span', {}, '每日已计量用量 · tokens')),
          cols.some((c) => c.value > 0) ? h('div', { 'data-bd-tok-days': '' }, cols.map((c) => h('div', { key: c.key, 'data-zero': c.value > 0 ? undefined : '', title: `${c.key} · ${fmt(c.value)} tokens` },
            h('div', { 'data-bd-tok-daytrack': '' }, h('i', { style: { height: Math.max(3, Math.round(c.value / dayMax * 100)) + '%' } })),
            h('span', {}, c.label)))) : h('div', { 'data-bd-tok-empty': '' }, '最近 14 天还没有已计量用量。')),
        h('section', { 'data-bd-ledger-tasks': '', 'aria-label': '每趟任务明细' },
          h('div', { 'data-bd-ledger-sectionhead': '' }, h('h3', {}, '每趟任务'),
            h('span', {}, `${rounds.length} 条记录${unknownCount ? ' · ' + unknownCount + ' 条未计量' : ''}${partialCount ? ' · ' + partialCount + ' 条部分计量' : ''}`)),
          h('div', { 'data-bd-tok-list': '' }, shownRounds.length ? shownRounds.map((r) => h('div', { 'data-bd-tokrow': '', key: r.id },
            h('time', { title: r.startedAt || '' }, petFmtTime(r.startedAt) || '—'),
            h('div', { 'data-bd-tok-task': '' },
              h('strong', {}, r.label || '任务'),
              h('span', { title: r.model || '' }, [r.model || '默认模型', Number(r.rounds) ? r.rounds + ' 轮' : '', Number(r.durationSec) ? fmtDurSec(r.durationSec) : ''].filter(Boolean).join(' · '))),
            h('div', { 'data-bd-tok-amount': '' },
              h('em', { 'data-unknown': unmetered(r) ? '' : undefined }, unmetered(r) ? '未计量' : fmt(r.tokens.total)),
              !unmetered(r) ? h('small', {}, partial(r) ? '部分计量 · 另有 ' + r.unknownRequests + ' 次缺失' : '输入 ' + fmt(r.tokens.input) + ' / 输出 ' + fmt(r.tokens.output)) : h('small', {}, '不按 0 计算')),
            r.stopReason ? h('i', { 'data-bd-tok-chip': '', 'data-warn': warnEnds.includes(String(r.stopReason)) ? '' : undefined, title: String(r.stopReason) }, endLabels[r.stopReason] || String(r.stopReason)) : null))
            : h('div', { 'data-bd-tok-empty': '' }, '还没有任务记录 —— 开一次会话刷或后台刷，这里就会记下来。')),
          focus && rounds.length > shownRounds.length ? h('p', { 'data-bd-note': '' }, '截图视图展示最近 4 条；退出后查看全部 ' + rounds.length + ' 条记录。') : null),
        h('p', { 'data-bd-ledger-footnote': '' }, '计量说明：累计数只含已知用量，任务明细独立记账。部分计量保留已知数及缺失次数；未计量不等于没有消耗。'),
        !focus ? h('section', { 'data-bd-ledger-controls': '' },
          h('div', { 'data-bd-ledger-sectionhead': '' }, h('h3', {}, '预算与计数'), h('span', {}, '仅保存后生效')),
          h('div', { 'data-bd-row': '' },
            h('label', { 'data-bd-field': '', 'data-bd-grow': '' }, h('span', { 'data-bd-label': '' }, '累计最多用多少 token（0 = 不限）'),
              h('input', { 'data-bd-input': '', type: 'number', min: 0, max: 50000000, step: 100000, value: budgetDraft ?? '0', onChange: (e) => setBudgetDraft(e.target.value) })),
            h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: saveBudget }, '保存上限'),
            h('button', { 'data-bd-btn': '', 'data-bd-danger': '', disabled: Boolean(busy), title: '累计和任务明细一起清零，上限不动；操作前需确认', onClick: clear }, '清零计数'))) : null)
    }

    function PetStickerThumb({ item, large = false }) {
      const [failed, setFailed] = React.useState(false)
      const url = String(item.imageUrl || '')
      React.useEffect(() => setFailed(false), [url])
      return h('div', { 'data-bd-sticker-thumb': '', 'data-large': large ? '' : undefined },
        !failed && url.startsWith(API + '/stickers/image?')
          ? h('img', { src: url, alt: item.name || '表情', loading: large ? 'eager' : 'lazy', decoding: 'async', onError: () => setFailed(true) })
          : h('span', {}, failed ? '图片暂时读不到' : '暂无预览'))
    }

    /* 图库按需读取；不会进入 /status，也不会在打开别的设置页时下载图片。 */
    function PetStickersPanel({ st, patch, busy, say }) {
      const cfg = st?.config || {}
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [working, setWorking] = React.useState('')
      const [draft, setDraft] = React.useState({})
      const [query, setQuery] = React.useState('')
      const [source, setSource] = React.useState('all')
      const [name, setName] = React.useState('')
      const [url, setUrl] = React.useState('')
      const [description, setDescription] = React.useState('')
      const [selected, setSelected] = React.useState('')
      const [uploadFile, setUploadFile] = React.useState(null)
      const [uploadName, setUploadName] = React.useState('')
      const [uploadDescription, setUploadDescription] = React.useState('')
      const [uploadPreview, setUploadPreview] = React.useState('')
      const [uploadError, setUploadError] = React.useState('')
      const [routeMissing, setRouteMissing] = React.useState(false)
      const fileInput = React.useRef(null)
      const fileReader = React.useRef(null)
      const fileVersion = React.useRef(0)
      const routeMissingRef = React.useRef(false)
      const alive = React.useRef(true)
      const reading = React.useRef(false)
      const writing = React.useRef(false)
      const [loading, setLoading] = React.useState(false)
      const defaults = { stickerCollectProbability: 35, stickerCollectCooldown: 60, stickerSendProbability: 30, stickerSendCooldown: 180, stickerCapacity: 60 }
      const field = (key) => draft[key] ?? cfg[key] ?? data?.settings?.[key] ?? defaults[key]
      const pull = async () => {
        if (reading.current || writing.current) return
        reading.current = true; setLoading(true)
        try {
          const r = await jget('/stickers')
          if (!r?.ok) throw new Error(r?.error || '图库暂时读不到')
          if (alive.current) { setData(r); setError(''); routeMissingRef.current = false; setRouteMissing(false) }
        } catch (e) {
          if (alive.current) {
            const missing = e?.status === 404 || /^HTTP 404\b/.test(String(e?.message || ''))
            routeMissingRef.current = missing; setRouteMissing(missing)
            setError(missing ? '当前 DSH 后端尚未加载图库接口。请完全退出并重新打开 DSH，再点「重试」；只刷新页面不会加载后端。' : String(e?.message ?? e))
          }
        }
        finally { reading.current = false; if (alive.current) setLoading(false) }
      }
      React.useEffect(() => {
        alive.current = true
        pull()
        const timer = setInterval(() => { if (!document.hidden && !routeMissingRef.current) pull() }, 20000)
        return () => { alive.current = false; clearInterval(timer); fileVersion.current++; fileReader.current?.abort?.() }
      }, [])
      const integer = (key, min, max) => {
        const v = field(key)
        const n = Number(v)
        if (String(v ?? '').trim() === '' || !Number.isSafeInteger(n) || n < min || n > max) throw new Error('请填写 ' + min + '–' + max + ' 之间的整数')
        return n
      }
      const save = async (kind) => {
        try {
          const p = kind === 'collect' ? {
            stickerCollectProbability: integer('stickerCollectProbability', 0, 100), stickerCollectCooldown: integer('stickerCollectCooldown', 0, 86400), stickerCapacity: integer('stickerCapacity', 1, 60),
          } : { stickerSendProbability: integer('stickerSendProbability', 0, 100), stickerSendCooldown: integer('stickerSendCooldown', 0, 86400) }
          if (await patch(p, kind === 'collect' ? '自动收集参数' : '自动配图参数')) setDraft((old) => Object.fromEntries(Object.entries(old).filter(([key]) => !(key in p))))
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const clearUpload = () => {
        fileVersion.current++; fileReader.current?.abort?.(); fileReader.current = null
        setUploadFile(null); setUploadPreview(''); setUploadError('')
        if (fileInput.current) fileInput.current.value = ''
      }
      const chooseFile = (event) => {
        const file = event.target.files?.[0]
        if (!file) return
        clearUpload()
        if (!file.size || file.size > 5 * 1024 * 1024) { setUploadError('请选择不超过 5 MB 的图片文件。'); return }
        const mime = String(file.type || '').toLowerCase()
        if (!(mime ? /^image\/(png|jpeg|gif|webp)$/.test(mime) : /\.(png|jpe?g|gif|webp)$/i.test(file.name))) {
          setUploadError('支持 PNG、JPEG、GIF、WebP 图片。'); return
        }
        const version = fileVersion.current
        const reader = new FileReader()
        fileReader.current = reader; setWorking('read-file')
        reader.onload = () => {
          if (!alive.current || fileVersion.current !== version) return
          fileReader.current = null; setWorking('')
          const result = String(reader.result || '')
          const comma = result.indexOf(',')
          if (comma < 0 || !result.slice(0, comma).endsWith(';base64')) { setUploadError('图片读取失败，请重新选择。'); return }
          setUploadFile({ name: file.name, size: file.size, dataBase64: result.slice(comma + 1) })
          // Preview only a browser-read image; the host independently checks the actual bytes.
          setUploadPreview(result)
          setUploadName((old) => old.trim() ? old : file.name.replace(/\.[^.]+$/, '').slice(0, 40))
        }
        reader.onerror = () => {
          if (alive.current && fileVersion.current === version) { fileReader.current = null; setWorking(''); setUploadError('文件读取失败，请重新选择图片。') }
        }
        try { reader.readAsDataURL(file) }
        catch { fileReader.current = null; setWorking(''); setUploadError('文件读取失败，请重新选择图片。') }
      }
      const mutate = async (kind, body) => {
        if (writing.current || reading.current) return
        writing.current = true; setWorking(kind)
        if (kind === 'upload') setUploadError('')
        try {
          const r = await jpost('/stickers/' + kind, body)
          if (!r?.ok) throw new Error(r?.error || '没有完成')
          if (!alive.current) return
          say(kind === 'collect' ? '已收进表情库。' : kind === 'upload' ? '已上传到表情库。' : '已从收集区移除。', 'good')
          if (kind === 'collect') { setName(''); setUrl(''); setDescription('') }
          if (kind === 'upload') { clearUpload(); setUploadName(''); setUploadDescription(''); setSource('collected'); setQuery(''); setSelected('collected:' + (r.name || body.name)) }
          if (kind === 'forget' && selected === 'collected:' + body.name) setSelected('')
        } catch (e) {
          if (alive.current) {
            const message = e?.status === 404 ? '当前 DSH 后端尚未加载这个图库功能。请完全退出并重新打开 DSH 后重试。' : String(e?.message ?? e)
            if (kind === 'upload') setUploadError(message)
            say(message, 'warn')
          }
        }
        finally { writing.current = false; if (alive.current) { setWorking(''); pull() } }
      }
      const upload = (event) => {
        event?.preventDefault?.()
        if (working || !uploadFile) return
        if (!uploadName.trim()) { setUploadError('请给表情起一个名字。'); return }
        mutate('upload', { name: uploadName.trim(), filename: uploadFile.name, dataBase64: uploadFile.dataBase64, description: uploadDescription.trim() })
      }
      const collect = (event) => {
        event?.preventDefault?.()
        if (!name.trim() || !/^https?:\/\//i.test(url.trim())) { say('填一个好叫的名字和 http(s) 图片链接。', 'warn'); return }
        mutate('collect', { name: name.trim(), url: url.trim(), description: description.trim() })
      }
      const forget = (item) => {
        if (!item.removable || item.source !== 'collected') return
        if (typeof window.confirm !== 'function' || !window.confirm('从收集区移除「' + item.name + '」？内置表情不会改变。')) return
        mutate('forget', { name: item.name })
      }
      const rows = Array.isArray(data?.stickers) ? data.stickers : []
      const q = query.trim().toLowerCase()
      const shown = rows.filter((item) => (source === 'all' || item.source === source) && (!q || [item.name, item.description, ...(Array.isArray(item.tags) ? item.tags : [])].some((v) => String(v || '').toLowerCase().includes(q))))
      const current = rows.find((item) => item.source + ':' + item.name === selected)
      const disabled = Boolean(busy || working || loading)
      const input = (label, key, max, suffix, min = 0) => h('label', { 'data-bd-sticker-number': '' }, h('span', {}, label),
        h('span', {}, h('input', { 'data-bd-input': '', type: 'number', min, max, step: 1, 'aria-label': label, value: field(key), onChange: (e) => setDraft((old) => ({ ...old, [key]: e.target.value })) }), h('small', {}, suffix)))
      return h('div', { 'data-bd-page-content': '', 'data-bd-settings-page': 'stickers' },
        h('div', { 'data-bd-pghead': '' }, h('div', {}, h('b', {}, '表情收藏'), h('p', {}, '逛评论区，遇见喜欢的就收一张。让每次配图都有点自己的意思。'))),
        h('div', { 'data-bd-pet-grid': '', 'data-bd-sticker-controls': '' },
          h('section', { 'data-bd-sec': '' }, h('div', { 'data-bd-h': '' }, h('b', {}, '自己收表情')),
            ToggleRow({ label: '从评论区自动收集', on: Boolean(cfg.stickerAutoCollect), disabled, note: '翻评论时，按概率收取观众附带的图片；同图不重复，库满就停。', onChange: (v) => patch({ stickerAutoCollect: v }, '自动收表情') }),
            input('收集概率', 'stickerCollectProbability', 100, '%'), input('收集冷却（秒）', 'stickerCollectCooldown', 86400, '秒'), input('收集容量', 'stickerCapacity', 60, '张', 1),
            h('button', { 'data-bd-btn': '', disabled, onClick: () => save('collect') }, '保存收集参数')),
          h('section', { 'data-bd-sec': '' }, h('div', { 'data-bd-h': '' }, h('b', {}, '发言时配一张')),
            ToggleRow({ label: '新评论自动配图', on: Boolean(cfg.stickerAutoSend), disabled, note: '有话想说并已允许评论时，从库里选一张。只对支持图片的新评论生效。', onChange: (v) => patch({ stickerAutoSend: v }, '自动配表情') }),
            input('配图概率', 'stickerSendProbability', 100, '%'), input('配图冷却（秒）', 'stickerSendCooldown', 86400, '秒'),
            h('p', { 'data-bd-note': '' }, '0% 不主动配图，100% 每次符合条件都尝试。指定了表情时优先使用指定项；不会开启评论或私信权限。'),
            h('button', { 'data-bd-btn': '', disabled, onClick: () => save('send') }, '保存配图参数'))),
        h('section', { 'data-bd-sec': '', 'data-bd-sticker-upload-card': '' },
          h('div', { 'data-bd-h': '' }, h('b', {}, '上传本地表情')),
          h('p', { 'data-bd-note': '', style: { margin: 0 } }, '支持 PNG、JPEG、GIF、WebP，单张不超过 5 MB。上传后放进「自己收集」，可以预览、配图或移除。'),
          h('form', { 'data-bd-sticker-upload': '', onSubmit: upload },
            h('div', { 'data-bd-sticker-upload-preview': '', 'aria-label': '待上传图片预览' }, uploadPreview ? h('img', { src: uploadPreview, alt: uploadName || '待上传表情' }) : h('span', {}, '图片预览')),
            h('div', { 'data-bd-sticker-upload-fields': '' },
              h('label', { 'data-bd-field': '' }, h('span', { 'data-bd-label': '' }, '选择本地图片'),
                h('input', { ref: fileInput, type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp', 'aria-label': '本地表情图片', disabled: Boolean(busy || working), onChange: chooseFile })),
              routeMissing ? h('div', { 'data-bd-note': '', role: 'status' }, '图库接口尚未加载，重启 DSH 后即可上传；下面可以手动重试连接。') : null,
              uploadFile ? h('div', { 'data-bd-row': '' }, h('span', { 'data-bd-sticker-fileinfo': '', 'data-bd-grow': '' }, uploadFile.name + ' · ' + (uploadFile.size < 1024 * 1024 ? Math.max(1, Math.round(uploadFile.size / 1024)) + ' KB' : (uploadFile.size / 1024 / 1024).toFixed(2) + ' MB')),
                h('button', { 'data-bd-btn': '', type: 'button', disabled: Boolean(working), onClick: clearUpload }, '取消选择')) : null,
              h('label', { 'data-bd-field': '' }, h('span', { 'data-bd-label': '' }, '表情名称'), h('input', { 'data-bd-input': '', 'aria-label': '上传表情名称', value: uploadName, maxLength: 40, placeholder: '默认用文件名，可以改个好叫的', onChange: (e) => setUploadName(e.target.value) })),
              h('label', { 'data-bd-field': '' }, h('span', { 'data-bd-label': '' }, '适合什么场景（可选）'), h('input', { 'data-bd-input': '', 'aria-label': '上传表情描述', value: uploadDescription, maxLength: 160, placeholder: '例：悄悄围观，或者开心得冒泡', onChange: (e) => setUploadDescription(e.target.value) })),
              uploadError ? h('div', { 'data-bd-msg': '', 'data-warn': '', role: 'alert' }, uploadError) : null,
              h('div', { 'data-bd-row': '' }, h('button', { 'data-bd-btn': '', 'data-primary': '', type: 'submit', disabled: disabled || routeMissing || !uploadFile || !uploadName.trim() }, working === 'upload' ? '正在上传…' : working === 'read-file' ? '正在读取…' : '上传到表情库'))))),
        h('section', { 'data-bd-sec': '' },
          h('div', { 'data-bd-row': '' }, h('div', { 'data-bd-h': '', 'data-bd-grow': '' }, h('b', {}, '我的表情库')),
            h('span', { 'data-bd-sticker-count': '' }, data ? '内置 ' + (data.counts?.builtin ?? rows.filter((x) => x.source === 'builtin').length) + ' · 收集 ' + (data.counts?.collected ?? rows.filter((x) => x.source === 'collected').length) + ' / ' + (data.capacity ?? field('stickerCapacity')) : error ? '未连接' : '读取中'),
            h('button', { 'data-bd-btn': '', disabled, onClick: pull }, '刷新图库')),
          h('div', { 'data-bd-row': '' }, h('input', { 'data-bd-input': '', 'data-bd-grow': '', placeholder: '找名字、描述或标签', 'aria-label': '搜索表情', value: query, onChange: (e) => setQuery(e.target.value) }),
            h('select', { 'data-bd-input': '', 'aria-label': '表情来源', value: source, onChange: (e) => setSource(e.target.value) }, h('option', { value: 'all' }, '全部来源'), h('option', { value: 'builtin' }, '内置表情'), h('option', { value: 'collected' }, '自己收集'))),
          error ? h('div', { 'data-bd-msg': '', 'data-warn': '', role: 'alert' }, '图库读取失败：' + error, h('button', { 'data-bd-btn': '', onClick: pull }, '重试')) : null,
          !data && error ? null : h('div', { 'data-bd-sticker-list': '', role: 'region', 'aria-label': '已有表情', tabIndex: 0 },
            shown.length ? h('div', { 'data-bd-sticker-grid': '' }, shown.map((item) => h('article', { 'data-bd-sticker-item': item.source, key: item.source + ':' + item.name },
              h('button', { 'data-bd-sticker-open': '', 'aria-label': '查看表情：' + item.name, onClick: () => setSelected(item.source + ':' + item.name) }, h(PetStickerThumb, { item })),
              h('div', { 'data-bd-sticker-caption': '' }, h('b', { title: item.name }, item.name), h('small', {}, item.source === 'builtin' ? '内置 · 只读' : '自己收集')),
              h('div', { 'data-bd-sticker-itemfoot': '' }, h('span', {}, Array.isArray(item.tags) ? item.tags.slice(0, 2).join(' · ') : ''),
                item.removable && item.source === 'collected' ? h('button', { 'data-bd-btn': '', 'data-sm': '', disabled, 'aria-label': '移除表情：' + item.name, onClick: () => forget(item) }, '移除') : null))))
              : h('div', { 'data-bd-sticker-empty': '' }, data ? q || source !== 'all' ? '没有找到匹配的表情。' : '还没有表情。可以手动收一张，或开启自动收集后去逛评论区。' : '正在打开表情库…')),
          current ? h('div', { 'data-bd-sticker-detail': '' }, h(PetStickerThumb, { item: current, large: true }),
            h('div', {}, h('div', { 'data-bd-row': '' }, h('b', { 'data-bd-grow': '' }, current.name), h('button', { 'data-bd-btn': '', onClick: () => setSelected('') }, '收起预览')),
              h('p', {}, current.description || '还没有描述'), h('p', {}, '来源：' + (current.from || (current.source === 'builtin' ? '内置表情库' : '手动收集'))),
              current.addedAt ? h('p', {}, '收于 ' + petFmtTime(current.addedAt)) : null,
              Array.isArray(current.tags) && current.tags.length ? h('p', {}, current.tags.join(' · ')) : null)) : null,
          h('div', { 'data-bd-note': '' }, data?.automation?.collectPending ? '正在收取 ' + data.automation.collectPending + ' 张，稍后刷新可查看。' : '自动收集保留来源并按图片内容去重。内置区只读，移除只影响自己收集的表情。')),
        h('details', { 'data-bd-sec': '', 'data-bd-advanced': '' }, h('summary', {}, '手动收一张'),
          h('form', { 'data-bd-sticker-form': '', onSubmit: collect },
            h('label', { 'data-bd-field': '' }, h('span', { 'data-bd-label': '' }, '给它起个名字'), h('input', { 'data-bd-input': '', 'aria-label': '表情名称', value: name, maxLength: 40, placeholder: '例：悄悄探头', onChange: (e) => setName(e.target.value) })),
            h('label', { 'data-bd-field': '' }, h('span', { 'data-bd-label': '' }, '图片链接'), h('input', { 'data-bd-input': '', 'aria-label': '图片链接', type: 'url', value: url, placeholder: 'https://…', onChange: (e) => setUrl(e.target.value) })),
            h('label', { 'data-bd-field': '' }, h('span', { 'data-bd-label': '' }, '适合什么场景'), h('input', { 'data-bd-input': '', 'aria-label': '表情描述', value: description, maxLength: 160, placeholder: '例：发现有趣的小细节时', onChange: (e) => setDescription(e.target.value) })),
            h('button', { 'data-bd-btn': '', 'data-primary': '', type: 'submit', disabled }, working === 'collect' ? '正在收…' : '收进表情库'))))
    }

    function PetSettingsModal({ onClose, toast, ctx, status, initialTab = 'basic' }) {
      const [tab, setTab] = React.useState(initialTab)
       const [runMode, setRunMode] = React.useState('session')
       const [logMode, setLogMode] = React.useState('events')
      const [runDrafts, setRunDrafts] = React.useState({})
      const runLock = React.useRef(false)
      const modalRef = React.useRef(null)
      /* ⭐ 2026-10-27：桌宠根（PetRoot）本来就在 5 秒轮一次 /status ⇒ 弹窗直接吃同一份，
       *    弹窗开着时的 /status 请求从两条并成一条。单独渲染（devtools 预检）没有 status prop
       *    ⇒ 自己轮询，行为跟以前完全一样（useStatus 内部 paused 挡住的是轮询，不是渲染）。 */
      const ownStatus = useStatus(5000, Boolean(status))
      const [st, setSt, fails] = status || ownStatus
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')
      /* 输入一律绑本地草稿：5 秒轮询会把正在打的字冲掉 */
      const [kws, setKws] = React.useState(null)
      const [wsDir, setWsDir] = React.useState(null)      // 跟 uiWorkspace 服务的名字区分开
      const [rl, setRl] = React.useState(null)
      const [perDay, setPerDay] = React.useState(null)
      const [dmUid, setDmUid] = React.useState(null)
      const [dmMode, setDmMode] = React.useState(null)
      const [persona, setPersona] = React.useState(null)
      const [momentStyle, setMomentStyle] = React.useState(null)
      const [momentPerDay, setMomentPerDay] = React.useState(null)
      const [modelId, setModelId] = React.useState(null)
      const [tokenBudget, setTokenBudget] = React.useState(null)
      const [totalTokenBudget, setTotalTokenBudget] = React.useState(null)
      const [maxRounds, setMaxRounds] = React.useState(null)
      const [paceFactor, setPaceFactor] = React.useState(null)
      const [scheduleAllDay, setScheduleAllDay] = React.useState(null)
      const [scheduleStart, setScheduleStart] = React.useState(null)
      const [scheduleEnd, setScheduleEnd] = React.useState(null)
      const [learnReviewModelId, setLearnReviewModelId] = React.useState(null)
      const [learnReviewBatchSize, setLearnReviewBatchSize] = React.useState(null)
      const [learnReviewMinutes, setLearnReviewMinutes] = React.useState(null)
      const [learnReviewTokenBudget, setLearnReviewTokenBudget] = React.useState(null)
      const [login, setLogin] = React.useState(null)
      const [loginState, setLoginState] = React.useState('')
      const [loginTone, setLoginTone] = React.useState('')
      const loginTimer = React.useRef(null)
      const alive = React.useRef(true)
      /* 🎬 视频那一卡的独立轮询：跑起来 3 秒、闲着 15 秒 */
      const [pv, setPv] = React.useState(null)
      const [pvDown, setPvDown] = React.useState(false)
      const [pvBusy, setPvBusy] = React.useState('')
      const [pvDay, setPvDay] = React.useState('')
      const [settingLogs, setSettingLogs] = React.useState(null)
      const [settingLogError, setSettingLogError] = React.useState('')
       const [settingLogFilter, setSettingLogFilter] = React.useState('')
       const [settingLogOpen, setSettingLogOpen] = React.useState({})
      /* 📡 活动流水（2026-10-27 从旧设置页搬进来 —— 桌宠化时它是唯一没跟进弹窗的主力功能）：
         单独 2.5 秒增量轮询，跟 5 秒的 /status 分开，不然那条流会一顿一顿的。 */
      const [acts, setActs] = React.useState([])
      const [actLive, setActLive] = React.useState(null)
      const pvRunning = Boolean(pv && pv.running)
      React.useEffect(() => {
        if (tab !== 'video') return
        let dead = false
        let timer = null
        const pull = async () => {
          try {
            const r = await jget('/pv')
            if (!dead && r) {
              if (r.ok === false) setPvDown(true)
              else { setPvDown(false); setPv(r) }
            }
          } catch { /* 抖一下就算了，下次接着拉 */ }
          if (dead) return
          timer = setTimeout(pull, pvRunning ? 3000 : 15000)
        }
        pull()
        return () => { dead = true; if (timer) clearTimeout(timer) }
      }, [tab, pvRunning])
      /* ⭐ 活动流水轮询：只拉增量（sinceUid = 已收到的最后一条 uid），报文一直很小。
         同一次工具调用先 call 后 done（共用一个 id）⇒ 原地改写那一行，不是再追加一条。 */
      const activityCursor = React.useRef('')
      React.useEffect(() => {
        if (tab !== 'logs') return
        let dead = false
        let sinceUid = activityCursor.current
        const pull = async () => {
          try {
            const r = await jget('/activity?sinceUid=' + encodeURIComponent(sinceUid))
            if (dead || !r) return
            // 「此刻在不在想」不跟增量走，是当场的状态 —— 每趟都要更新
            if (r.live) setActLive(r.live)
            if (Array.isArray(r.rows) && r.rows.length) {
              sinceUid = String(r.last || sinceUid)
               activityCursor.current = sinceUid
              setActs((old) => {
                const next = old.slice()
                const byUid = new Map(next.map((x) => [x && (x.uid || x.id), x]))
                for (const row of r.rows) {
                  if (!row) continue
                  const key = row.uid || row.id
                  // 同一个 id 的是「同一次调用的后续状态」：原地改写，别追加成两行
                  const at = row.id ? next.findIndex((x) => x && x.id === row.id) : -1
                  if (at >= 0) next[at] = { ...next[at], ...row, t: next[at].t || row.t }
                  else if (!key || !byUid.has(key)) next.push(row)
                }
                return next.length > 200 ? next.slice(next.length - 200) : next
              })
            }
          } catch { /* 抖一下就算了，下次接着拉 */ }
        }
        pull()
        const t = setInterval(pull, 2500)
        return () => { dead = true; clearInterval(t) }
      }, [tab])

      const onClearAct = async () => {
        try { await jpost('/activity', { clear: true }); setActs([]); activityCursor.current = '' } catch (e) { say(String(e?.message ?? e), 'warn') }
      }

      const logRev = React.useRef('')
      React.useEffect(() => {
        if (tab !== 'logs') return
        let dead = false
        let timer = null
        const pull = async () => {
          try {
            const r = await jget('/pet/log?n=60' + (logRev.current ? '&rev=' + encodeURIComponent(logRev.current) : ''))
            if (dead) return
            if (!r || r.ok === false) { setSettingLogError((r && r.error) || '读不到'); return }
            if (r.unchanged) return          // ⭐ 没新增行就不重渲染
            if (r.rev) logRev.current = String(r.rev)
            setSettingLogs(Array.isArray(r.entries) ? r.entries.slice(-60) : [])
            setSettingLogError('')
          } catch (e) { if (!dead) setSettingLogError(String(e?.message ?? e)) }
          finally { if (!dead) timer = setTimeout(pull, 7000) }
        }
        pull()
        return () => { dead = true; if (timer) clearTimeout(timer) }
      }, [tab])
      /* ⚠️ 扫码轮询的 timer 必须能停（切走/关弹窗后还跑会在已卸载组件上 setState） */
      React.useEffect(() => () => {
        alive.current = false
        if (loginTimer.current) { clearInterval(loginTimer.current); loginTimer.current = null }
      }, [])

      const cfg = st && st.config
      React.useEffect(() => {
        const previous = document.activeElement
        const node = modalRef.current
        if (node?.querySelector) node.querySelector('[data-bd-pet-tab][data-on]')?.focus()
        return () => { if (previous?.isConnected && previous.focus) previous.focus() }
      }, [Boolean(cfg)])
      const lim = (st && st.limits) || {}
      const numLim = (key, lo, hi) => {
        const v = lim[key]
        return Array.isArray(v) && v.length === 2 ? v : [lo, hi]
      }
      const clampField = (key, val, lo, hi) => {
        const [a, b] = numLim(key, lo, hi)
        const n = Number(val)
        return Math.max(a, Math.min(Number.isFinite(n) ? n : a, b))
      }
      React.useEffect(() => {
        if (!cfg) return
        if (kws === null) setKws((cfg.keywords || []).join('\n'))
        if (wsDir === null) setWsDir(cfg.workspace || '')
        if (rl === null) setRl(cfg.reportLevel || 'full')
        if (perDay === null) setPerDay(String(cfg.perDay ?? 5))
        if (dmUid === null) setDmUid(cfg.dmUid ? String(cfg.dmUid) : '')
        if (dmMode === null) setDmMode(cfg.dmMode || 'off')
        if (persona === null) setPersona(cfg.persona || '')
        if (momentStyle === null) setMomentStyle(cfg.momentStyle || '感想')
        if (momentPerDay === null) setMomentPerDay(String(cfg.momentPerDay ?? 1))
        if (modelId === null) setModelId(cfg.modelId || '')
        if (tokenBudget === null) setTokenBudget(String(cfg.tokenBudget ?? 0))
        if (totalTokenBudget === null) setTotalTokenBudget(String(cfg.totalTokenBudget ?? 0))
        if (maxRounds === null) setMaxRounds(String(cfg.maxRounds ?? 64))
                 if (paceFactor === null) setPaceFactor(String(cfg.paceFactor ?? 1))
         if (scheduleAllDay === null) setScheduleAllDay(Boolean(cfg.scheduleAllDay))
         if (scheduleStart === null) setScheduleStart(String(cfg.scheduleStart || '18:00'))
         if (scheduleEnd === null) setScheduleEnd(String(cfg.scheduleEnd || '09:00'))
         if (learnReviewModelId === null) setLearnReviewModelId(String(cfg.learnReviewModelId || ''))
         if (learnReviewBatchSize === null) setLearnReviewBatchSize(String(cfg.learnReviewBatchSize ?? 20))
         if (learnReviewMinutes === null) setLearnReviewMinutes(String(cfg.learnReviewMinutes ?? 10))
         if (learnReviewTokenBudget === null) setLearnReviewTokenBudget(String(cfg.learnReviewTokenBudget ?? 12000))
      }, [cfg])

      const say = (text, tone) => { setMsg(text); setMsgTone(tone || '') }
      const patch = async (p, what) => {
        setBusy(JSON.stringify(p))
        try {
          const r = await jpost('/config', p)
          if (r?.config) setSt((old) => ({ ...old, config: r.config }))
          const clamped = Array.isArray(r?.clamped) ? r.clamped : []
          const clampTxt = clamped.map((c) => `${c.key} 想要 ${c.want}，最多只能 ${c.got}`).join('；')
          if (r?.host && r.host.ok === false) say(`${what || '设置'}：插件自己那份存了，但宿主那份配置没写进去（${r.host.error}）`, 'warn')
          else if (clamped.length) say(`${what || '设置'}：存下了，但有项目超出允许范围被改了 —— ${clampTxt}`, 'warn')
          else say(what ? `${what}：已保存` : '已保存', 'good')
          /* 数字框回填成真存下来的值（不然界面显示 100、实际存 50） */
          if (clamped.length) {
            for (const c of clamped) {
              if (c.key === 'perDay') setPerDay(String(c.got))
              else if (c.key === 'momentPerDay') setMomentPerDay(String(c.got))
              else if (c.key === 'maxRounds') setMaxRounds(String(c.got))
              else if (c.key === 'tokenBudget') setTokenBudget(String(c.got))
              else if (c.key === 'totalTokenBudget') setTotalTokenBudget(String(c.got))
              else if (c.key === 'paceFactor') setPaceFactor(String(c.got))
            }
          }
          return true
        } catch (e) { say(String(e?.message ?? e), 'warn'); return false }
        finally { setBusy('') }
      }
      const sw = (k) => Boolean(cfg && cfg[k])

      const onLoginStart = async () => {
        setBusy('login')
        setLoginTone('')
        setLoginState('正在出码…')
        try {
          const r = await jpost('/login/start', {})
          if (!r?.ok) { setLoginTone('warn'); setLoginState(r?.error || '出码失败'); return }
          setLogin({ key: r.key, qr: r.qr })
          if (!r.qr) { setLoginTone('warn'); setLoginState('没画出二维码 —— 先点上面的「装主依赖」（venv 里要有 qrcode）') }
          else setLoginState('用手机 B站 扫这张码')
          if (loginTimer.current) { clearInterval(loginTimer.current); loginTimer.current = null }
          let n = 0
          const stop = () => { clearInterval(timer); if (loginTimer.current === timer) loginTimer.current = null }
          const timer = setInterval(async () => {
            if (!alive.current) { stop(); return }
            n += 1
            try {
              const p = await jpost('/login/poll', { key: r.key })
              if (p?.state === 'ok') {
                stop(); setLogin(null); setLoginTone('good'); setLoginState('登录成功')
                setSt((old) => ({ ...old, loggedIn: true }))
              } else if (p?.state === 'scanned') { setLoginTone(''); setLoginState('扫到了，请在手机上确认') }
              else if (p?.state === 'expired') { stop(); setLogin(null); setLoginTone('warn'); setLoginState('二维码过期了，再点一次「扫码登录」') }
              else if (p?.state === 'unknown') {
                stop(); setLogin(null); setLoginTone('warn')
                setLoginState('没登上：' + (p?.message || '响应里没有 SESSDATA —— 再点一次「扫码登录」'))
              } else { setLoginTone(''); setLoginState('等扫码…') }
            } catch { /* 抖动就下次再问 */ }
            if (n > 90) { stop(); setLogin(null); setLoginTone('warn'); setLoginState('超时了，再点一次「扫码登录」') }
          }, 2000)
          loginTimer.current = timer
        } catch (e) { setLoginTone('warn'); setLoginState(String(e?.message ?? e)) }
        finally { setBusy('') }
      }
      const onInstall = async () => {
        setBusy('install'); say('')
        try {
          const r = await jpost('/install', {})
          say(r?.hint || '已经在后台开始装了', '')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }
      const onCheck = async () => {
        setBusy('check'); say('')
        try {
          const r = await jpost('/check', {})
          if (r && r.ok) say('能用！' + (r.steps || []).join('、'))
          else say('还不能用：' + (r && r.error ? r.error : '没拿到结果'))
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }
      const onInstallAsr = async () => {
        setBusy('asr'); say('')
        try {
          const r = await jpost('/install-asr', {})
          say(r?.started ? '开始装转写依赖 —— 进度显示在下面（要下模型，慢一点正常）' : (r?.hint || '没起来'),
            r?.started ? 'good' : 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }
      /* 🎬 视频动作：先拦日期格式，再 POST /pv */
      const onPvMake = async (force) => {
        const day = (pvDay || (pv && pv.yesterday) || '').trim()
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { say('先选一天（YYYY-MM-DD）', 'warn'); return }
        setPvBusy('make')
        try {
          const r = await jpost('/pv', { action: 'make', date: day, force: force === true })
          if (!r || r.ok === false) { say('没做成：' + ((r && r.error) || '未知原因'), 'warn'); return }
          if (r.skipped) { say(`这天已经有视频了：${r.file}（要重做就再点一次「重做」）`, 'warn'); return }
          say(`开始做 ${r.date} 的视频了 —— 一条约 2–6 分钟，做完这张卡会自己变成播放器。`, 'good')
          setPv((old) => ({ ...(old || {}), running: true, stage: 'plan', date: r.date }))
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setPvBusy('') }
      }
      const onPvStop = async () => {
        setPvBusy('stop')
        try {
          const r = await jpost('/pv', { action: 'stop' })
          say(r && r.stopped ? '停下了。' : '它本来就没在做。', r && r.stopped ? 'warn' : '')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setPvBusy('') }
      }
      const onPvRefresh = async () => {
        try { const r = await jget('/pv'); if (r) setPv(r) } catch { /* 下次轮询会补 */ }
      }
      const onPvRedo = () => onPvMake(true)
      const copyText = async (text) => {
        const v = String(text || '')
        try { await navigator.clipboard.writeText(v); toast('已复制：' + v, 'good') }
        catch { toast('复制失败 —— 路径是：' + v) }
      }

      const tabDefs = [['basic', '偏好与桌宠', '口吻 / 选片 / 报告'], ['run', '运行方式', '会话 / 后台 / 定时'], ['speech', '互动与投递', '发言 / 私信 / 节奏'],
        ['stickers', '表情收藏', '图库 / 收集 / 配图'], ['learning', '学习与记忆', '自动审核 / 记录'], ['ledger', 'token 账本', '用量 / 预算'], ['logs', '运行日志', '实时动态 / 事件'], ['video', '日报视频', '制作 / 配音'], ['other', '账号与环境', '登录 / 依赖 / 镜像']]
      const modalShell = (body) => h('div', { 'data-bd-pet-mask': '', onPointerDown: (e) => { if (e.target === e.currentTarget) onClose() } },
        h('div', { 'data-bd-pet-modal': '', role: 'dialog', 'aria-modal': true, 'aria-label': '鲸鱼摸鱼设置', ref: modalRef,
          onKeyDown: (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); onClose() }
            if (e.key === 'Tab' && e.currentTarget.querySelectorAll) {
              const nodes = Array.from(e.currentTarget.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]')).filter((el) => el.getClientRects().length)
              const first = nodes[0], last = nodes[nodes.length - 1]
              if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
              else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
            }
          } },
          h('header', { 'data-bd-settings-head': '' }, h(SettingsAvatar),
            h('div', { 'data-bd-settings-title': '' }, h('b', {}, '鲸鱼摸鱼 · 设置'), h('p', {}, '慢慢逛，调成你喜欢的样子。')),
            h('button', { 'data-bd-pet-close': '', onClick: onClose, title: '关闭（ESC）', 'aria-label': '关闭设置' }, '×')),
          h('div', { 'data-bd-settings-layout': '' },
            h('nav', { 'data-bd-pet-tabs': '', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': '设置分类', onKeyDown: (e) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
              e.preventDefault()
              const current = tabDefs.findIndex(([key]) => key === tab)
              const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown'
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabDefs.length - 1 : (current + (forward ? 1 : -1) + tabDefs.length) % tabDefs.length
              setTab(tabDefs[next][0]); e.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus()
            } }, ...tabDefs.flatMap(([key, label, note], i) => [
              i === 0 || i === 4 || i === 7 ? h('div', { key: 'group-' + key, 'data-bd-nav-group': '', role: 'presentation' }, i === 0 ? '日常使用' : i === 4 ? '记录与成长' : '制作与维护') : null,
              h('button', { key, id: 'bd-tab-' + key, 'data-bd-pet-tab': '', role: 'tab', 'aria-selected': tab === key, 'aria-controls': 'bd-settings-content', tabIndex: tab === key ? 0 : -1,
                'data-on': tab === key ? '' : undefined, onClick: () => setTab(key) }, label, h('small', {}, note)),
            ]), h('div', { 'data-bd-nav-foot': '' }, 'DAFEIYU', h('br'), '小小控制室 / LOCAL')),
            h('main', { 'data-bd-settings-main': '' },
              msg ? h('div', { style: { margin: '14px 26px 0' }, role: msgTone === 'warn' ? 'alert' : 'status' },
                h('div', { 'data-bd-msg': '', 'data-warn': msgTone === 'warn' ? '' : undefined, 'data-good': msgTone === 'good' ? '' : undefined }, msg)) : null,
              h('div', { 'data-bd-pet-body': '', id: 'bd-settings-content', role: 'tabpanel', 'aria-labelledby': 'bd-tab-' + tab }, body)))))

      if (!cfg) {
        return h('div', { 'data-bd-pet-mask': '' },
          h('div', { 'data-bd-pet-modal': '' },
            h('div', { 'data-bd-pet-tabs': '' },
              h('span', { 'data-bd-pet-tab': '', style: { cursor: 'default' } }, '鲸鱼摸鱼设置'),
              h('button', { 'data-bd-pet-close': '', onClick: onClose }, '✕')),
            h('div', { 'data-bd-pet-body': '' },
              h('div', { 'data-bd-note': '' }, fails >= 3
                ? '读不到插件配置（已经试了 ' + fails + ' 次）—— 完全退出 DSH Desktop 再打开试试。'
                : '读设置中…'))))
      }

      /* 每项只在一页出现；旧 Panel 仅供历史回归工具使用，不挂入弹窗。 */
      const icon = (name) => h(PetIcon, { name })
      const heading = (_name, title) => h('div', { 'data-bd-h': '' }, h('b', {}, title))
      const pvCard = () => {
        if (pvDown) return h('section', { 'data-bd-sec': '' }, heading('film', '视频暂时不可用'),
          h('div', { 'data-bd-msg': '', 'data-warn': '' }, '读不到视频服务，请稍后重试。'),
          h('button', { 'data-bd-btn': '', onClick: onPvRefresh }, '重新读取'))
        const videos = Array.isArray(pv && pv.videos) ? pv.videos : []
        const latest = videos.length ? videos[0] : null
        const shown = (pv && pv.file && pv.stage === 'done') ? pv.file : (latest ? latest.file : '')
        const shownDay = (pv && pv.stage === 'done' && pv.date) ? pv.date : (latest ? latest.date : '')
        const deps = pv ? pv.deps : null
        const stageTxt = pv && pv.running
          ? (pv.stage === 'plan' ? '正在整理分镜…' : '正在渲染画面…')
          : ''
        return h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, icon('film'), h('b', {}, '冲浪日报视频'),
            pv && pv.running ? h('span', { 'data-bd-badge': '', 'data-live': '' }, stageTxt) : null,
            deps === false ? h('span', { 'data-bd-badge': '', 'data-warn': '' }, '依赖没装') : null,
            videos.length ? h('span', { 'data-bd-badge': '' }, `${videos.length} 条成品`) : null),
          h('div', { 'data-bd-note': '' },
            '把某一天的冲浪情况做成一条由鲸鱼摸鱼讲解配音的短片，存进当天文件夹。做在本地，不发布。'),
          deps === false ? h('div', { 'data-bd-msg': '', 'data-warn': '' },
            '渲染要的三样东西没装齐（edge-tts / imageio-ffmpeg / Pillow）—— 到「账号与环境」点一次「装主依赖」即可。') : null,
          h('div', { 'data-bd-row': '' },
            h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '做哪一天'),
            h('input', {
              'data-bd-input': '', style: { width: '150px' }, type: 'date',
              value: pvDay || (pv && pv.yesterday) || '', onChange: (e) => setPvDay(e.target.value),
            })),
          h('div', { 'data-bd-row': '' },
            h('button', {
              'data-bd-btn': '', 'data-primary': '', disabled: Boolean(pvBusy) || pvRunning || deps === false,
              onClick: () => onPvMake(false),
            }, pvRunning ? '正在做…' : '做这一天的视频'),
            pvRunning ? h('button', { 'data-bd-btn': '', 'data-sm': '', disabled: Boolean(pvBusy), onClick: onPvStop }, '停下') : null,
            shown ? h('button', { 'data-bd-btn': '', 'data-sm': '', disabled: Boolean(pvBusy) || pvRunning, onClick: onPvRedo }, '重做这天') : null,
            h('button', { 'data-bd-btn': '', 'data-sm': '', disabled: Boolean(pvBusy), onClick: onPvRefresh }, '刷新')),
          pv && pv.running ? h('div', { 'data-bd-msg': '' },
            `${pv.date}：${stageTxt}已 ${Math.round((Number(pv.ms) || 0) / 1000)} 秒。这一步要占几分钟 CPU，可以先干别的，做完这里会自己出画面。`) : null,
          pv && !pv.running && pv.stage === 'failed' ? h('div', { 'data-bd-msg': '', 'data-warn': '' },
            `上一次没做成：${pv.error || '未知原因'}` + (pv.log ? `（日志：${pv.log}）` : '')) : null,
          pv && !pv.running && pv.stage === 'stopped' ? h('div', { 'data-bd-msg': '', 'data-warn': '' }, '上一次是手动停下的。') : null,
          shown
            ? h('div', { 'data-bd-field': '' },
              h('video', {
                src: `/api/bili-duty/pv/video?day=${encodeURIComponent(shownDay)}&t=${Number(latest && latest.at ? Date.parse(latest.at) : 0) || 0}`,
                controls: true, preload: 'metadata',
                style: { width: '100%', borderRadius: '10px', background: '#000', display: 'block' },
              }),
              h('div', { 'data-bd-row': '' },
                h('span', { 'data-bd-note': '', 'data-bd-grow': '' },
                  `${shownDay} · ${latest && latest.mb != null ? `${latest.mb} MB` : ''} · ${shown}`),
                h('button', { 'data-bd-btn': '', 'data-sm': '', onClick: () => copyText(shown) }, '复制路径')))
            : h('div', { 'data-bd-empty': '' },
              pvRunning ? '第一条正在做，做完会出现在这里' : '还没有成品 —— 选个日期点「做这一天的视频」'),
          videos.length > 1 ? h('div', { 'data-bd-kv': '' },
            '以前做的：' + videos.slice(0, 6).map((v) => `${v.date}${v.mb != null ? `（${v.mb}MB）` : ''}`).join(' · ')) : null,
          h('div', { 'data-bd-field': '' },
            h('div', { 'data-bd-row': '', 'data-bd-toggle': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '每天自动做「昨天」的'),
                h('div', { 'data-bd-note': '' }, '到了下面的时间点，如果昨天的成品还没有，就自己补一条。')),
              h(Switch, {
                on: Boolean(pv && pv.auto), disabled: Boolean(pvBusy),
                onChange: async (v) => {
                  // 乐观更新 + 失败回滚（同 Panel 那套：等轮询回来才动，人会以为没点上）
                  setPv((old) => ({ ...(old || {}), auto: v }))
                  const okSaved = await patch({ pvAuto: v }, '每天自动做视频')
                  if (!okSaved) setPv((old) => ({ ...(old || {}), auto: !v }))
                },
              })),
            h('div', { 'data-bd-row': '' },
              h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '每天几点做'),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', style: { width: '96px' }, type: 'time',
                value: (pv && pv.at) || '10:30',
                onChange: (e) => {
                  const v = e.target.value
                  if (!/^\d{2}:\d{2}$/.test(v)) return
                  setPv((old) => ({ ...(old || {}), at: v }))
                  patch({ pvAt: v }, '自动做视频的时间')
                },
              })),
            h('div', { 'data-bd-row': '' },
              h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '配音音色'),
              h('select', {
                'data-bd-input': '', style: { width: '230px' },
                value: (pv && pv.voice) || 'zh-CN-XiaoyiNeural',
                onChange: (e) => patch({ pvVoice: e.target.value }, '配音音色'),
              },
              h('option', { value: 'zh-CN-XiaoyiNeural' }, '晓伊（默认 · 偏软）'),
              h('option', { value: 'zh-CN-XiaoxiaoNeural' }, '晓晓（更清亮）'),
              h('option', { value: 'zh-CN-XiaochenNeural' }, '晓辰（偏成熟）'))),
            /* 参考音色三件套：DraftInput（本地草稿、失焦/回车才提交），语义与 Panel 相同 */
            h('div', { 'data-bd-row': '' },
              h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, 'GPT-SoVITS 目录'),
              h(DraftInput, {
                width: '300px', type: 'text', placeholder: 'D:\\...\\GPT-SoVITS',
                value: (pv && pv.gsvRepo) || '', onCommit: (v) => patch({ pvGsvRepo: v }, 'GPT-SoVITS 目录'),
              })),
            h('div', { 'data-bd-row': '' },
              h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '参考音频（3~10 秒）'),
              h(DraftInput, {
                width: '300px', type: 'text', placeholder: 'D:\\...\\voice-ds\\ref\\dwg_0031_ref.wav',
                value: (pv && pv.gsvRef) || '', onCommit: (v) => patch({ pvGsvRef: v }, '参考音频'),
              })),
            h('div', { 'data-bd-row': '' },
              h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '参考音频的原话'),
              h(DraftInput, {
                width: '300px', type: 'text', placeholder: '那段音频里说的那句话（逐字）',
                value: (pv && pv.gsvPrompt) || '', onCommit: (v) => patch({ pvGsvPrompt: v }, '参考音频原话'),
              })),
            h('div', { 'data-bd-row': '' },
              h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '跑 GPT-SoVITS 的 Python'),
              h(DraftInput, {
                width: '300px', type: 'text', placeholder: '留空 = 用上面那个 python',
                value: (pv && pv.gsvPython) || '', onCommit: (v) => patch({ pvGsvPython: v }, 'GPT-SoVITS 的 Python'),
              })),
            h('div', { 'data-bd-note': '' },
              '默认走 edge-tts（需联网）；参考音色配置齐全后使用本地 GPT-SoVITS，速度取决于设备。')))
      }

      const settingLogRows = tab === 'logs' && logMode === 'events' && Array.isArray(settingLogs) ? settingLogs.filter((e) => {
        const q = String(settingLogFilter || '').trim().toLowerCase()
        if (!q) return true
        return [e && e.type, e && e.event, e && e.text, e && e.raw ? JSON.stringify(e.raw) : ''].some((v) => String(v || '').toLowerCase().includes(q))
      }).slice(-60) : []
      const settingLogView = () => settingLogs === null
        ? h('div', { 'data-bd-note': '', 'data-bd-settings-log': '' }, '正在读取运行日志…')
        : settingLogRows.length
          ? h('div', { 'data-bd-settings-log': '' }, settingLogRows.map((e) => { const key = String(e.eventId || e.uid || e.id || [e.at, e.type, petEntrySummary(e)].join(':')); return h('div', { 'data-bd-logrow': '', 'data-t': petEntryTone(e), key },
            h('div', { 'data-bd-row': '' },
              h('time', { 'data-bd-note': '' }, petFmtTime(e && e.at)),
              h('span', { 'data-bd-logevent': '', 'data-bd-grow': '' }, petEntrySummary(e)),
              h('button', { 'data-bd-btn': '', 'data-sm': '', onClick: () => setSettingLogOpen((old) => ({ ...old, [key]: !old[key] })) }, settingLogOpen[key] ? '收起' : '详情')),
            settingLogOpen[key] ? h('pre', { 'data-bd-pre': '' }, petEntryRaw(e)) : null) }))
          : h('div', { 'data-bd-empty': '' }, settingLogFilter ? '没有匹配的运行日志。' : '还没有运行记录。启动一次会话或后台任务后，这里会显示过程。')
      const settingLogCard = () => h('section', { 'data-bd-sec': '', 'data-bd-span': '2' },
        heading('list', '近期运行日志'),
        h('div', { 'data-bd-row': '' },
          h('span', { 'data-bd-note': '', 'data-bd-grow': '' }, '保留最近 60 条：启动、暂停、后台完成和错误都会写在这里。可按事件筛选，点击详情查看原始字段。'),
          h('button', { 'data-bd-btn': '', 'data-sm': '', disabled: Boolean(busy), onClick: async () => {
            try {
              const r = await jget('/pet/log?n=60')
              if (!r || r.ok === false) throw new Error((r && r.error) || '读不到日志')
              setSettingLogs(Array.isArray(r.entries) ? r.entries.slice(-60) : [])
              setSettingLogError('')
              say('运行日志已刷新', 'good')
            } catch (e) { setSettingLogError(String(e?.message ?? e)); say('日志刷新失败：' + String(e?.message ?? e), 'warn') }
          } }, '刷新'),
           h('input', { 'data-bd-input': '', 'data-sm': '', value: settingLogFilter, placeholder: '筛事件、结果或错误', 'aria-label': '筛选运行日志', onChange: (e) => setSettingLogFilter(e.target.value) })),
        settingLogError ? h('div', { 'data-bd-msg': '', 'data-warn': '' }, '日志读取失败：' + settingLogError) : null,
        settingLogView())
      const runSettings = (mode) => {
        const prefix = mode === 'session' ? 'session' : 'background'
        const saved = {
          model: cfg[prefix + 'ModelId'] ?? cfg.modelId ?? '',
          tokenBudget: cfg[prefix + 'TokenBudget'] ?? cfg.tokenBudget ?? 0,
          maxRounds: cfg.sessionMaxRounds ?? cfg.maxRounds ?? 64,
          durationMinutes: cfg[prefix + 'Minutes'] ?? (mode === 'session' ? 0 : 45),
          /* ⭐ 后台「时段」任务：填了 start–end 就在段内一直刷（跨午夜算到次日），留空才退回刷一轮 */
          windowStart: cfg.backgroundWindowStart ?? '',
          windowEnd: cfg.backgroundWindowEnd ?? '',
        }
        return { ...saved, ...(runDrafts[mode] || {}) }
      }
      const updateRun = (mode, field, value) => setRunDrafts((old) => ({
        ...old, [mode]: { ...(old[mode] || {}), [field]: value },
      }))
      const readRun = (mode) => {
        const draft = runSettings(mode)
        const integer = (value, lo, hi, label) => {
          const n = Number(value)
          if (String(value).trim() === '' || !Number.isSafeInteger(n) || n < lo || n > hi) {
            throw new Error(label + '需要填写 ' + lo + '–' + hi + ' 之间的整数')
          }
          return n
        }
        /* ⭐ 后台时段（2026-10-28）：两个要么都填、要么都空；填了就得是 HH:MM 且不能相等 */
        if (mode === 'background') {
          const start = String(draft.windowStart ?? '').trim(), end = String(draft.windowEnd ?? '').trim()
          const hm = (v) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(v)
          if ((start && !end) || (!start && end)) throw new Error('后台时段的「开始」和「结束」要一起填（或都留空，退回刷一轮）')
          if (start && !hm(start)) throw new Error('后台时段的开始时间要写成 时:分（例如 20:00）')
          if (end && !hm(end)) throw new Error('后台时段的结束时间要写成 时:分（例如 23:00）')
          if (start && start === end) throw new Error('后台时段的开始和结束不能是同一分钟')
        }
        return {
          model: String(draft.model || '').trim(),
          tokenBudget: integer(draft.tokenBudget, 0, 5_000_000, 'token 预算'),
          durationMinutes: integer(draft.durationMinutes, mode === 'session' ? 0 : 1, mode === 'session' ? 1440 : 180, '运行时长'),
          ...(mode === 'session' ? { maxRounds: integer(draft.maxRounds, 1, numLim('maxRounds', 1, 1000)[1], '轮数') } : {}),
          /* ⭐ 时段只走 /config 持久化（常设指令），**不进 /pet/start 请求体**——那条契约被 E2E 严格钉死 */
          ...(mode === 'background' ? { windowStart: String(draft.windowStart ?? '').trim(), windowEnd: String(draft.windowEnd ?? '').trim() } : {}),
        }
      }
      const runConfig = (mode, options) => {
        const prefix = mode === 'session' ? 'session' : 'background'
        return {
          [prefix + 'ModelId']: options.model,
          [prefix + 'TokenBudget']: options.tokenBudget,
          [prefix + 'Minutes']: options.durationMinutes,
          ...(mode === 'session' ? { sessionMaxRounds: options.maxRounds } : {}),
          /* ⭐ 后台时段落 config：常设指令，DSH 重启后 automationTick 自己把它捞起来 */
          ...(mode === 'background' ? { backgroundWindowStart: options.windowStart, backgroundWindowEnd: options.windowEnd } : {}),
        }
      }
      const saveRun = async (mode) => {
        try {
          const options = readRun(mode)
          if (await patch(runConfig(mode, options), mode === 'session' ? '新会话默认设置' : '后台默认设置')) {
            setRunDrafts((old) => ({ ...old, [mode]: options }))
          }
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const startRun = async (mode) => {
        if (runLock.current) return
        let options
        try { options = readRun(mode) } catch (e) { say(String(e?.message ?? e), 'warn'); return }
        runLock.current = true
        setBusy('start-' + mode)
        say('')
        try {
          let sessionId
          if (mode === 'session') {
            const created = await jpost('/pet/session-new', newSessionContext(ctx))
            if (!created?.ok || !created.sessionId) throw new Error((created?.error || '没能创建会话') + (created?.hint ? '；' + created.hint : ''))
            sessionId = created.sessionId
          }
          /* ⭐ 时段不走请求体：host 从 config 里读常设时段，手动开始只负责"现在就跑" */
          const body = mode === 'session'
            ? { mode, model: options.model, tokenBudget: options.tokenBudget, durationMinutes: options.durationMinutes, maxRounds: options.maxRounds }
            : { mode, model: options.model, tokenBudget: options.tokenBudget, durationMinutes: options.durationMinutes }
          const r = await jpost('/pet/start', { ...body, ...(sessionId ? { sessionId } : {}) })
          if (!r?.ok || r.started === false) throw new Error((r?.error || r?.hint || '没有启动') + (r?.error && r?.hint ? '；' + r.hint : ''))
          if (sessionId) {
            try {
              const workspace = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
              if (workspace && typeof workspace.openSession === 'function') await workspace.openSession(sessionId)
            } catch { /* 已启动的会话仍可从侧栏打开 */ }
            say('已在新会话开始刷，可以从会话列表查看过程。', 'good')
          } else say('后台已开始，运行进度会显示在这里。', 'good')
          try { const fresh = await jget('/status'); if (fresh?.ok) setSt(fresh) } catch { /* 下次轮询补上 */ }
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { runLock.current = false; setBusy('') }
      }
      const controlRun = async (action) => {
        if (runLock.current) return
        runLock.current = true
        setBusy('control')
        try {
          const r = await jpost('/feiyu', { action, ...(st.feiyu?.sessionId ? { sessionId: st.feiyu.sessionId } : {}) })
          if (!r?.ok) throw new Error(r?.error || r?.hint || '操作没有完成')
          say(action === 'stop' ? '已暂停。' : action === 'resume' ? '已接着刷。' : '已收台。', 'good')
          const fresh = await jget('/status')
          if (fresh?.ok) setSt(fresh)
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { runLock.current = false; setBusy('') }
      }
      const modelField = (mode) => {
        const current = String(runSettings(mode).model || '')
        const models = Array.isArray(st.models) ? st.models : []
        const props = { 'data-bd-input': '', 'aria-label': '运行模型', value: current, onChange: (e) => updateRun(mode, 'model', e.target.value) }
        return models.length ? h('select', props,
          h('option', { value: '' }, mode === 'session' ? '使用当前会话的模型' : '使用宿主默认模型'),
          current && !models.some((m) => m.id === current) ? h('option', { value: current }, current + '（当前清单外）') : null,
          models.map((m) => h('option', { key: m.id, value: m.id }, m.label || m.id)))
          : h('input', { ...props, placeholder: 'provider/model；留空使用默认模型' })
      }
      const runPage = (mode) => {
        const session = mode === 'session'
        const options = runSettings(mode)
        const fy = st.feiyu || {}
        const live = session ? Boolean(fy.active) : Boolean(st.bgBusy)
        const tokens = fy.tokens || {}
        return h('div', { 'data-bd-page-content': '', 'data-bd-settings-page': mode },
          h('div', { 'data-bd-pet-grid': '' },
            h('section', { 'data-bd-sec': '' }, heading('sliders', '下次怎么刷'),
              h('label', { 'data-bd-field': '' }, h('span', { 'data-bd-label': '' }, '使用的模型'), modelField(mode)),
              /* ⭐ 后台「时段」任务（2026-10-28 使用者要求）：填了 start–end，段内就**一直刷**——
               *    一轮接一轮接力到时段结束；DSH 重启 / 提前收工 / 崩溃都会被每分钟的调度钩子
               *    拉起来接着刷（配置是常设指令，不用守着）。留空才退回「刷一轮 X 分钟」。 */
              ...(!session ? [
                h('div', { 'data-bd-row': '' },
                  h('label', { 'data-bd-field': '', 'data-bd-grow': '' }, h('span', { 'data-bd-label': '' }, '从几点刷到几点'),
                    h('input', { 'data-bd-input': '', type: 'time', value: options.windowStart || '', onChange: (e) => updateRun(mode, 'windowStart', e.target.value) })),
                  h('span', { 'data-bd-label': '', style: { padding: '0 2px' } }, '→'),
                  h('label', { 'data-bd-field': '', 'data-bd-grow': '' }, h('span', { 'data-bd-label': '' }, '结束（可跨午夜）'),
                    h('input', { 'data-bd-input': '', type: 'time', value: options.windowEnd || '', onChange: (e) => updateRun(mode, 'windowEnd', e.target.value) }))),
              ] : []),
              h('label', { 'data-bd-field': '' }, h('span', { 'data-bd-label': '' }, session ? '最多运行几分钟（0 = 不限时）' : '没填时段时，一轮刷几分钟'),
                h('input', { 'data-bd-input': '', type: 'number', min: session ? 0 : 1, max: session ? 1440 : 180, step: 1,
                  value: options.durationMinutes, onChange: (e) => updateRun(mode, 'durationMinutes', e.target.value) })),
              session ? h('label', { 'data-bd-field': '' }, h('span', { 'data-bd-label': '' }, '最多刷多少轮'),
                h('input', { 'data-bd-input': '', type: 'number', min: 1, max: numLim('maxRounds', 1, 1000)[1], step: 1,
                  value: options.maxRounds, onChange: (e) => updateRun(mode, 'maxRounds', e.target.value) })) : null,
              h('label', { 'data-bd-field': '' }, h('span', { 'data-bd-label': '' }, '这趟 token 预算（0 = 不限）'),
                h('input', { 'data-bd-input': '', type: 'number', min: 0, max: 5000000, step: 1000,
                  value: options.tokenBudget, onChange: (e) => updateRun(mode, 'tokenBudget', e.target.value) })),
              h('div', { 'data-bd-note': '' }, session
                ? '轮数与 token 在每轮结束后检查，可能略超预算；到达时限会暂停续轮，当前轮可能继续到结束。'
                + '⭐ 它刷着的时候你随时插一句话，当前那轮就会作废重来 —— 想下指令（挑点别的、停下、换个口味）就大方打字，不用等它问。'
                : (String(options.windowStart || '') && String(options.windowEnd || '')
                  ? `时段任务：${options.windowStart}–${options.windowEnd} 内一直刷，一轮接一轮到时段结束；中途关掉 DSH，重新打开也会在时段内自动接着刷。手动「停止」后本时段不再自动拉起。token 预算是软目标，不能精确截断。`
                  : '填上「从几点刷到几点」就是常设时段任务（推荐）；留空则按下面的分钟数刷一轮，提前做完会自动接着刷到点。token 预算交给后台代理作任务目标，不能按精确用量自动截断。')),
              h('div', { 'data-bd-row': '' },
                h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: () => saveRun(mode) }, '保存默认设置'),
                h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: Boolean(busy) || live, onClick: () => startRun(mode) },
                  icon(session ? 'play' : 'moon'), busy === 'start-' + mode ? '启动中…' : session ? '新开会话，开始刷' : '开始后台刷')),
              h('div', { 'data-bd-note': '' }, '两个模式分别保存。修改参数不会改变正在运行的任务。')),
            h('section', { 'data-bd-sec': '' }, heading('pulse', '运行状态'),
              h('span', { 'data-bd-badge': '', 'data-live': live ? '' : undefined },
                live ? '运行中' : session && (fy.goal?.phase === 'paused' || fy.goal?.phase === 'blocked') ? '已暂停' : '空闲'),
              session ? h('div', { 'data-bd-readout': '' },
                h('div', {}, h('b', {}, fy.goal ? (fy.goal.rounds || 0) + ' / ' + (fy.goal.maxRounds || 0) : fy.source === 'manual' ? '手动刷站' : '—'), h('span', {}, '已刷轮数')),
                h('div', {}, h('b', {}, tokens.thisRun === null || tokens.thisRun === undefined || tokens.tokensUnknown ? '未计量' : Number(tokens.thisRun).toLocaleString()), h('span', {}, '本趟 token')),
                h('div', {}, h('b', {}, st.pickedToday ?? 0), h('span', {}, '今日精选'))) : null,
              h('div', { 'data-bd-kv': '' }, '当前模型：' + (session ? fy.modelActive || fy.model || '—' : st.backgroundRun?.model || (live ? '运行中' : '—'))),
              /* ⏳ 时段任务进度（2026-10-28）：跑几小时的活不能只有「运行中」三个字 */
              !session && live && st.backgroundRun && Number(st.backgroundRun.deadlineAt) > 0 && Number(st.backgroundRun.startedAt) > 0 ? (() => {
                const start = Number(st.backgroundRun.startedAt), end = Number(st.backgroundRun.deadlineAt)
                const pct = Math.max(0, Math.min(100, Math.round(((Date.now() - start) / Math.max(1, end - start)) * 100)))
                const isWindow = Boolean(st.backgroundRun.windowEndAt)
                return h('div', {},
                  h('div', { 'data-bd-kv': '' },
                    (isWindow ? '本时段已刷 ' : '本轮已跑 ') + fmtSpanMs(Date.now() - start)
                    + (isWindow ? ' · 还剩 ' + fmtSpanMs(Math.max(0, end - Date.now())) : '')),
                  h('div', { 'data-bd-tok-bar': '', title: '进度 ' + pct + '%' }, h('i', { style: { width: pct + '%' } })))
              })() : null,
              session && fy.source === 'manual' && live ? h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: () => controlRun('stop') }, '停止手动刷站') : null,
              session && fy.goal ? h('div', { 'data-bd-row': '' },
                live ? h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: () => controlRun('stop') }, '暂停')
                  : h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: () => controlRun('resume') }, '接着刷'),
                h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: () => controlRun('clear') }, '收台')) : null,
              !session && live ? h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: async () => {
                setBusy('stop-bg')
                try { const r = await jpost('/pet/stop', {}); if (!r?.ok) throw new Error(r?.error || '没有停下'); say('已停止后台任务。', 'good') }
                catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
              } }, '停止后台任务') : null,
              !session && st.lastRunAt ? h('div', { 'data-bd-note': '' }, '上次运行：' + petFmtTime(st.lastRunAt)) : null,
              h('div', { 'data-bd-note': '' }, '详细过程可在左侧「运行日志」中查看。'),
              /* ⏸️ 免跑牌期间如实说（st.bgWindow.holdUntil 由宿主 /status 提供） */
              !session && st.bgWindow && Number(st.bgWindow.holdUntil) > Date.now()
                ? h('div', { 'data-bd-note': '' }, `本时段已停止自动拉起（到 ${new Date(st.bgWindow.holdUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）；点「开始后台刷」可立刻恢复。`)
                : null)))
      }

      /* 🐟 鲸鱼摸鱼模式的派生读数（流水卡和徽章共用） */
      const fyLive = Boolean((st.feiyu || {}).active)

      const scheduleCard = () => h('section', { 'data-bd-sec': '', 'data-bd-span': '2' },
        heading('pulse', '定时自动运行'),
        ToggleRow({
          label: '每天按时间自动跑一轮', on: sw('scheduleEnabled'), disabled: Boolean(busy),
          note: '开启后每天只启动一次后台任务；窗口内重复刷新不会叠加运行。',
          onChange: (v) => patch({ scheduleEnabled: v }, '定时自动运行'),
        }),
        sw('scheduleEnabled') ? h('div', { 'data-bd-sub': '' },
          h('div', { 'data-bd-row': '', 'data-bd-toggle': '' },
            h('div', { 'data-bd-grow': '' },
              h('div', { 'data-bd-label': '' }, '运行范围'),
              h('div', { 'data-bd-note': '' }, scheduleAllDay ? '全天开放，今天第一次检查时启动' : '按下面的本地时间窗口执行，可跨午夜')),
            h(Switch, {
              on: Boolean(scheduleAllDay), disabled: Boolean(busy),
              onChange: (v) => { setScheduleAllDay(v); patch({ scheduleAllDay: v }, '定时运行范围') },
            })),
          !scheduleAllDay ? h('div', { 'data-bd-row' : '' },
            h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '开始时间'),
            h('input', { 'data-bd-input': '', type: 'time', value: scheduleStart || '18:00', onChange: (e) => { setScheduleStart(e.target.value); patch({ scheduleStart: e.target.value }, '定时开始时间') } }),
            h('span', { 'data-bd-label': '' }, '结束时间'),
            h('input', { 'data-bd-input': '', type: 'time', value: scheduleEnd || '09:00', onChange: (e) => { setScheduleEnd(e.target.value); patch({ scheduleEnd: e.target.value }, '定时结束时间') } })) : null,
          h('div', { 'data-bd-row' : '' },
            h('span', { 'data-bd-badge': '', 'data-live': st.schedule && st.schedule.inWindow ? '' : undefined }, st.schedule && st.schedule.inWindow ? '当前在窗口内' : '当前不在窗口内'),
            h('span', { 'data-bd-note': '', 'data-bd-grow': '' }, st.schedule && st.schedule.lastError ? '上次失败：' + st.schedule.lastError : st.schedule && st.schedule.lastStartedAt ? '上次启动：' + petFmtTime(st.schedule.lastStartedAt) : '尚未启动'),
            st.schedule && st.schedule.nextRunAt ? h('span', { 'data-bd-note': '' }, '下次检查：' + petFmtTime(st.schedule.nextRunAt)) : null)) : null)
      const basicCards = [
        () => h('div', { 'data-bd-sec': '', 'data-bd-basic-card': 'pet' },
          heading('spark', '桌宠'),
          ToggleRow({
            label: '显示桌宠', on: !(st && st.petShow === false), disabled: Boolean(busy),
            note: st && st.petShow === false
              ? '藏起来了 —— 打开开关，几秒后它就游回来。'
              : '右键打开菜单；左键可拖动，双击按已保存的参数开新会话。',
            onChange: (v) => patch({ petShow: v }, '显示桌宠'),
          }),
          ToggleRow({
            label: '空闲时自言自语', on: !(st && st.config && st.config.idleChatter === false), disabled: Boolean(busy),
            note: '闲着的时候偶尔冒一句观察（两三个小时一条）——嫌吵就关成安静模式。',
            onChange: (v) => patch({ idleChatter: v }, '闲聊泡泡'),
          })),
        () => h('div', { 'data-bd-sec': '' },
          heading('spark', '刷什么 · 用什么口气'),
          h('div', { 'data-bd-note': '' }, '只在「鲸鱼摸鱼模式」预设里生效，留空用预设自带的那套口吻。'),
          h('textarea', {
            'data-bd-input': '', rows: 4, value: persona === null ? '' : persona,
            placeholder: '例：像个爱折腾的技术宅，说人话，看到夸大宣传会忍不住吐槽。',
            onChange: (e) => setPersona(e.target.value),
          }),
          h('div', { 'data-bd-row': '' },
            h('span', { 'data-bd-note': '', 'data-bd-grow': '' },
              persona && persona.length > 400 ? `已写 ${persona.length} 字（每轮都占一份 token）` : ''),
            h('button', {
              'data-bd-btn': '', 'data-primary': '', disabled: Boolean(busy),
              onClick: () => patch({ persona: String(persona || '').trim() }, '人格设定'),
            }, '保存'))),
        () => h('div', { 'data-bd-sec': '' },
          heading('list', '限量与报告'),
          h('div', { 'data-bd-row': '' },
            h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '一天最多挑几条'),
            h('input', {
              'data-bd-input': '', 'data-bd-num': '', type: 'number',
              min: numLim('perDay', 0, 50)[0], max: numLim('perDay', 0, 50)[1],
              value: perDay === null ? '5' : perDay, onChange: (e) => setPerDay(e.target.value),
            })),
          h('div', { 'data-bd-row': '' },
            h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '报告详细程度'),
            h('select', {
              'data-bd-input': '', style: { width: '140px' },
              value: rl === null ? 'full' : rl, onChange: (e) => setRl(e.target.value),
            },
            h('option', { value: 'full' }, '完整'),
            h('option', { value: 'brief' }, '精简'),
            h('option', { value: 'off' }, '不写'))),
          h('div', { 'data-bd-row': '' },
            h('button', {
              'data-bd-btn': '', 'data-primary': '', disabled: Boolean(busy),
              onClick: () => patch({ perDay: clampField('perDay', perDay, 0, 50), reportLevel: rl || 'full' }, '限量与报告'),
            }, '保存'))),
        () => h('div', { 'data-bd-sec': '' },
          heading('dots', '长期偏好'),
          h('div', { 'data-bd-note': '' }, '关键词与参考文件提供长期背景，不限制她刷什么。参考路径不改变新会话所属工作区。'),
          h('textarea', {
            'data-bd-input': '', rows: 3, placeholder: '一行一个',
            value: kws === null ? '' : kws, onChange: (e) => setKws(e.target.value),
          }),
          h('input', {
            'data-bd-input': '', 'aria-label': '参考文件或目录', placeholder: '参考文件或目录（可选）',
            value: wsDir === null ? '' : wsDir, onChange: (e) => setWsDir(e.target.value),
          }),
          h('div', { 'data-bd-row': '' },
            h('button', {
              'data-bd-btn': '', disabled: Boolean(busy),
              onClick: async () => {
                const list = String(kws || '').split('\n').map((s) => s.trim()).filter(Boolean)
                await patch({ keywords: list, workspace: String(wsDir || '').trim() }, '长期偏好')
              },
            }, '保存'))),
        () => h('div', { 'data-bd-sec': '' },
          heading('pulse', '出手的节奏'),
          h('div', { 'data-bd-row': '' },
            h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '节奏倍数（0.3 快 / 1 正常 / 3 慢三倍）'),
            h('input', {
              'data-bd-input': '', 'data-bd-num': '', type: 'number', step: 0.1,
              min: numLim('paceFactor', 0.3, 3)[0], max: numLim('paceFactor', 0.3, 3)[1],
              value: paceFactor === null ? '1' : paceFactor, onChange: (e) => setPaceFactor(e.target.value),
            })),
          h('div', { 'data-bd-note': '' },
            '倍数只影响「下次该等多久」，不会把已经钉下的间隔缩短 —— 想让它立刻变快，等手上这一条发完再调。'),
          h('div', { 'data-bd-row': '' },
            h('button', {
              'data-bd-btn': '', disabled: Boolean(busy),
              onClick: () => patch({ paceFactor: clampField('paceFactor', paceFactor, 0.3, 3) }, '出手节奏'),
            }, '保存'))),

        /* ── 📡 它刚才在干嘛（2026-10-27 从旧设置页搬进来）：实时流水是桌宠化时唯一没跟进弹窗的
         *    主力功能，这里补上。2.5 秒增量轮询 + 「正在想」呼吸条（模型读字幕的几十秒里流水
         *    静止，靠它撑住"没卡死"这口气）。 */
        () => h('section', { 'data-bd-sec': '', 'data-bd-span': '2' },
          h('div', { 'data-bd-row': '' },
            h('div', { 'data-bd-h': '', 'data-bd-grow': '' }, icon('pulse'), h('b', {}, '它刚才在干嘛'),
              h('span', { 'data-bd-badge': '', 'data-live': fyLive ? '' : undefined }, fyLive ? '在刷' : '没在刷')),
            h('button', { 'data-bd-btn': '', 'data-sm': '', onClick: onClearAct, disabled: Boolean(busy) }, '清屏')),
          fyLive && actLive && actLive.thinking
            ? h('div', { 'data-bd-thinking': '' },
              h('i', { 'data-bd-dot': '' }),
              h('span', { 'data-bd-grow': '' }, actLive.round
                ? `第 ${actLive.round}${actLive.maxRounds ? '/' + actLive.maxRounds : ''} 轮 · 正在想（翻字幕、挑片子、琢磨怎么冒泡）`
                : '正在想（翻字幕、挑片子、琢磨怎么冒泡）'),
              actLive.since
                ? h('time', {}, '已跑 ' + fmtSpanMs(actLive.since))
                : null)
            : null,
          h('div', { 'data-bd-act': '' },
            acts.length === 0
              ? h('div', { 'data-bd-empty': '' }, '还没动静～开冲之后这儿会一条条冒出来：搜了啥、挑了哪条、读到第几秒')
              : acts.map((a) => h('div', { 'data-bd-actline': '', 'data-kind': a.kind || 'info', key: a.id || a.seq },
                h('time', {}, petFmtTime(a.t)),
                h('span', {}, a.text),
                a.kind === 'call' ? h('em', { 'data-bd-running': '' }, '进行中') : null))),
          h('div', { 'data-bd-note': '' }, '它每做一件事都会在这里说一句人话；更完整的来龙去脉看下面的「近期运行日志」。'))
      ]
      const pageHead = (title, note) => h('div', { 'data-bd-pghead': '' }, h('div', {}, h('b', {}, title), h('p', {}, note)))
      const basicPage = () => {
        /* 🧭 新手三步（2026-10-28）：齐了这张卡自己消失 —— 不用任何人去关它 */
        const steps = [
          { done: Boolean(st && st.venvReady), label: '装主依赖（Python 环境）', view: 'other' },
          { done: Boolean(st && st.loggedIn), label: '扫码登录 B站', view: 'other' },
          { done: Boolean(Number(st && st.ranToday) || (st && st.lastRunAt)), label: '开第一把刷', view: 'run' },
        ]
        const todo = steps.filter((s) => !s.done)
        return h('div', { 'data-bd-page-content': '', 'data-bd-settings-page': 'basic' },
          pageHead('偏好与桌宠', '选什么，怎么说，记录多少。每张卡独立保存。'),
          todo.length ? h('section', { 'data-bd-sec': '', 'data-bd-onboard': '' },
            h('div', { 'data-bd-h': '' }, icon('spark'), h('b', {}, '先把鱼安顿好（三步，齐了这张卡自己消失）')),
            ...steps.map((s) => h('div', { 'data-bd-row': '', key: s.label },
              h('span', { 'data-bd-badge': '', 'data-live': s.done ? '' : undefined }, s.done ? '✓ 已完成' : '待办'),
              h('span', { 'data-bd-grow': '', style: { fontWeight: s.done ? 400 : 600 } }, s.label),
              s.done ? null : h('button', { 'data-bd-btn': '', 'data-sm': '', onClick: () => setTab(s.view) }, '去处理')))) : null,
          h('div', { 'data-bd-pet-grid': '', 'data-bd-basic-grid': '' }, basicCards[1](), basicCards[3](), basicCards[0](), basicCards[2]()))
      }
      const speechPage = () => h('div', { 'data-bd-page-content': '', 'data-bd-settings-page': 'speech' },
        pageHead('互动与投递', '公开冒泡和私信往来，各有自己的开关。'),
        h('div', { 'data-bd-pet-grid': '' },
          h('section', { 'data-bd-sec': '' }, heading('spark', '公开发言'), ToggleRow({
            label: '自动发说说', on: sw('autoMoment'), disabled: Boolean(busy),
            note: '把这一轮的想法发成 B站 动态。默认关；关着的时候它一次都不会发。',
            onChange: (v) => patch({ autoMoment: v }, '自动发说说'),
          }),
          sw('autoMoment') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '口吻'),
              h('select', {
                'data-bd-input': '', 'data-bd-num': '', style: { width: '104px' },
                value: momentStyle === null ? '感想' : momentStyle, onChange: (e) => setMomentStyle(e.target.value),
              },
              ['感想', '吐槽', '安利', '冷知识'].map((s) => h('option', { key: s, value: s }, s)))),
            h('div', { 'data-bd-row': '' },
              h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '每天动态目标'),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number',
                min: numLim('momentPerDay', 0, 50)[0], max: numLim('momentPerDay', 0, 50)[1],
                value: momentPerDay === null ? '1' : momentPerDay, onChange: (e) => setMomentPerDay(e.target.value),
              })),
            h('div', { 'data-bd-note': '' }, '每天要发够这个量（不是"最多"——是当日目标；0 = 永远不发；后端上限 50）。')) : null,
          ToggleRow({
            label: '自动评论视频', on: sw('autoComment'), disabled: Boolean(busy),
            note: '看完有具体想说的话时再评论，也可以安静看完。按自己的口气说，不用 @ 任何人。',
            onChange: (v) => patch({ autoComment: v }, '自动评论'),
          }),
          sw('autoComment') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-note': '' }, '没有每日条数上限；是否评论由她自己决定。同一个视频只评一次，发送仍按节奏闸执行。'),
            dmMode === 'only' ? h('div', { 'data-bd-msg': '', 'data-warn': '' },
              '评论开关开着但不生效：投递方式是「只发私信」，公开评论整个关掉了～') : null) : null,
          ToggleRow({
            label: '自动回复评论', on: sw('replyToComments'), disabled: Boolean(busy),
            note: '有人回了你的评论，它想回就回 —— 不必每条都搭话。每轮先看一眼有没有人回你。',
            onChange: (v) => patch({ replyToComments: v }, '自动回复评论'),
          }),
          sw('replyToComments') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-note': '' }, '想回就回，没有条数上限，也可以不理。同一条只回一次 —— 它记着账本，不会对着一个人刷屏。')) : null,
            h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: () => patch({ momentStyle: momentStyle || '感想', momentPerDay: clampField('momentPerDay', momentPerDay, 0, 50) }, '动态设置') }, '保存动态设置')),
          h('section', { 'data-bd-sec': '' }, heading('key', '私信与投递'), ToggleRow({
            label: '私信投递', on: dmMode !== 'off' && dmMode !== null, disabled: Boolean(busy),
            note: '可选择私信或同时投递；填写你的收件 UID 后保存。',
            onChange: (v) => setDmMode(v ? 'both' : 'off'),
          }),
          dmMode !== 'off' && dmMode !== null ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '收件人 UID'),
              h('input', {
                'data-bd-input': '', style: { width: '150px' }, placeholder: '数字 UID',
                value: dmUid === null ? '' : dmUid, onChange: (e) => setDmUid(e.target.value),
              })),
            h('div', { 'data-bd-row': '' },
              h('span', { 'data-bd-label': '', 'data-bd-grow': '' }, '方式'),
              h('select', {
                'data-bd-input': '', style: { width: '150px' },
                value: dmMode || 'off', onChange: (e) => setDmMode(e.target.value),
              },
              h('option', { value: 'off' }, '只发评论区'),
              h('option', { value: 'only' }, '只发私信'),
              h('option', { value: 'both' }, '两边都发')))) : null,
          /* 自动回复私信：跟「私信投递」是两件事（那是往外发成果，这是回别人发来的） */
          ToggleRow({
            label: '自动回复私信', on: sw('autoReplyDm'), disabled: Boolean(busy),
            note: '别人私信你，它就按自己那套脾气回一句。想回就回，不回也不算欠着。',
            onChange: (v) => patch({ autoReplyDm: v }, '自动回复私信'),
          }),
          sw('autoReplyDm') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-note': '' },
              `没有每日条数上限 —— 想回就回。同一条私信只回一次；新鲜事只回 ${DM_STALE_DAYS} 天内的，晾着的旧消息不去翻。`),
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '只回我关注的人'),
                h('div', { 'data-bd-note': '' }, '开着更安全：陌生人私信多半是广告引流，一律不回；关掉就是谁都回。')),
              h(Switch, {
                on: Boolean(sw('dmReplyFollowedOnly')), disabled: Boolean(busy),
                onChange: (v) => patch({ dmReplyFollowedOnly: v }, '只回我关注的人'),
              }))) : null,
            h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: () => patch({ dmMode: dmMode || 'off', dmUid: String(dmUid || '').trim() }, '私信投递设置') }, '保存投递设置')),
          basicCards[4](), h('section', { 'data-bd-sec': '' }, heading('pulse', '此刻能不能发'), (() => {
            const pc = st && st.pace
            if (!pc || pc.ok === false) return h('div', { 'data-bd-note': '' }, '节奏读不到（可能要重启一次让新版生效）')
            const cd = pc.cooldown
            const qt = pc.quota
            const ks = pc.kinds || {}
            /* 🗨️ 先说人话（2026-10-28）：把节奏账翻译成一句有期待感的总结，技术读数放后面 */
            const waits = Object.values(ks).map((v) => Number(v.waitSec) || 0)
            const maxWait = waits.length ? Math.max(0, ...waits) : 0
            const summary = cd
              ? `她在小黑屋冷静，约 ${Math.ceil((Number(cd.waitSec) || 0) / 60)} 分钟后回来 —— 这段时间别催。`
              : qt && Object.keys(qt).length
                ? '评论额度用完了，她先安静看片，到点自己再探。'
                : maxWait > 0
                  ? `下一次出手大约 ${Math.ceil(maxWait / 60)} 分钟后 —— 现在她在安静看片。`
                  : '现在出手很顺，她想发就发。'
            const qRow = qt && Object.keys(qt).length
              ? (() => {
                const q = Object.values(qt)[0] || {}
                const m = Math.max(1, Math.ceil((Number(q.waitSec) || 0) / 60))
                const strike = Number(q.strikes) || 1
                return h('div', { 'data-bd-msg': '', 'data-warn': '' },
                  `📉 评论额度满了（12014）：先歇 ${m} 分钟，到点自动再探一次`
                  + `（第 ${strike} 次，再撞会停更久：45 分 → 90 分 → 180 分封顶）。`
                  + '这不是风控，是账号的评论额度用完了（越撞停得越久）—— 回私信、回动态评论、发动态都不受影响。')
              })()
              : null
            const rows = Object.entries(ks).map(([k, v]) => {
              const wait = Number(v.waitSec) || 0
              return h('div', { 'data-bd-kv': '', key: k },
                `${v.label || k}：${wait > 0 ? '还要等 ' + (wait >= 90 ? Math.ceil(wait / 60) + ' 分钟' : wait + ' 秒') : '现在可以'}`
                + ` · 间隔 ${v.gapSec}~${Number(v.gapSec) + Number(v.jitterSec)} 秒 · 每小时最多 ${v.hourCap} 条`)
            })
            const burst = pc.burst || {}
            return h('div', { 'data-bd-sub': '' },
              h('div', { 'data-bd-msg': '', 'data-good': !cd && !(qt && Object.keys(qt).length) ? '' : undefined }, summary),
              cd ? h('div', { 'data-bd-msg': '', 'data-warn': '' },
                `🚧 正在冷却：${cd.why || '被风控拦了'}`
                + `（${cd.code || '?'}）—— 还要等 ${Math.ceil((Number(cd.waitSec) || 0) / 60)} 分钟。`
                + '这段别让它试探性再发，风控是越试越久的。') : null,
              qRow,
              h('div', { 'data-bd-msg': '', 'data-good': '' },
                `现在可以发：${Object.entries(ks).filter(([, v]) => Number(v.waitSec) <= 0).map(([, v]) => v.label).join('、') || '都还得等等'}`),
              ...rows,
              h('div', { 'data-bd-note': '' },
                `连发刹车：${burst.windowMin || 10} 分钟里最多 ${burst.max || 10} 次出手（不管哪一类，已经用了 ${burst.used || 0} 次）—— `
                + '风控看的是"这个号在动"，不看动的是哪一种。'))
          })(),
            h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: async () => {
              setBusy('verify'); try { const r = await jpost('/verify', {}); if (!r?.ok) throw new Error(r?.error || '复核失败'); const rows = Array.isArray(r.checked) ? r.checked : []; say(rows.length ? '复核 ' + rows.length + ' 条，公开可见 ' + rows.filter(x => x.visible === true).length + ' 条。' : r.text || '没有需要复核的发言', 'good') } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
            } }, '复核发言'))))
      const runView = () => h('div', { 'data-bd-page-content': '', 'data-bd-settings-page': 'run' },
        pageHead('运行方式', '会话、后台分开保存。定时规则归在后台方式里。'),
        h('div', { 'data-bd-segments': '', 'aria-label': '运行方式' }, ...[['session','新开会话刷'], ['background','后台与定时']].map(([mode, label]) => h('button', { key: mode, 'aria-pressed': runMode === mode, onClick: () => setRunMode(mode) }, label))),
        runPage(runMode), runMode === 'background' ? scheduleCard() : null)
      const logsPage = () => h('div', { 'data-bd-page-content': '', 'data-bd-settings-page': 'logs' },
        pageHead('运行日志', '实时动态与运行事件，保留完整上下文。列表内滚动查看。'),
        h('div', { 'data-bd-row': '' },
          h('div', { 'data-bd-segments': '', 'aria-label': '日志类型' }, ...[['events','运行事件'], ['activity','实时动态']].map(([mode, label]) => h('button', { key: mode, 'aria-pressed': logMode === mode, onClick: () => setLogMode(mode) }, label))),
          h('span', { 'data-bd-grow': '' }),
          st.feiyu?.active ? h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: () => controlRun('stop') }, '暂停会话') : null,
          st.bgBusy ? h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: async () => { setBusy('stop-bg'); try { const r = await jpost('/pet/stop', {}); if (!r?.ok) throw new Error(r?.error || '停止失败'); say('已请求停止后台任务', 'good') } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') } } }, '停止后台任务') : null),
        logMode === 'events' ? settingLogCard() : basicCards[5]())
      const videoPage = () => h('div', { 'data-bd-page-content': '', 'data-bd-settings-page': 'video' },
        h('div', { 'data-bd-pghead': '' }, icon('film'), h('div', {}, h('b', {}, '视频'),
          h('p', {}, '制作日报、查看成品和配置配音。'))), pvCard())
      const otherPage = () => h(PetOtherSettings, { view: tab === 'learning' ? 'learning' : 'environment', st, setSt, busy, setBusy, say, patch, login, loginState,
        loginTone, onLoginStart, onInstall, onCheck, onInstallAsr, copyText, sw })
      const ledgerPage = () => h(PetTokenLedger, {
        st, budgetDraft: totalTokenBudget, setBudgetDraft: setTotalTokenBudget, busy,
        saveBudget: () => patch({ totalTokenBudget: clampField('totalTokenBudget', totalTokenBudget, 0, 50000000) }, '累计上限'),
        resetTokens: async () => {
          if (!await patch({ resetTokensTotal: true }, '累计 token 清零')) return
          try { const fresh = await jget('/status'); if (fresh?.ok) setSt(fresh) } catch { /* 下次状态轮询会补上 */ }
        },
      })
      return modalShell(tab === 'basic' ? basicPage() : tab === 'run' ? runView() : tab === 'speech' ? speechPage() : tab === 'logs' ? logsPage()
        : tab === 'stickers' ? h(PetStickersPanel, { st, patch, busy, say }) : tab === 'video' ? videoPage() : tab === 'ledger' ? ledgerPage() : otherPage())

    }

    function PetMenuPreview({ kind, anchor, st, fails, tokenValue, tokenNote, onEnter, onLeave }) {
      const box = React.useRef(null)
      const [placement, setPlacement] = React.useState(null)
      React.useEffect(() => {
        const place = () => {
          if (!anchor?.getBoundingClientRect) return
          const item = anchor.getBoundingClientRect()
          const menu = anchor.closest?.('[data-bd-menu]')?.getBoundingClientRect() || item
          const vw = window.innerWidth || 1280, vh = window.innerHeight || 800, gap = 8, edge = 10
          const leftRoom = menu.left - edge - gap, rightRoom = vw - menu.right - edge - gap
          const sideRoom = Math.max(leftRoom, rightRoom)
          const side = sideRoom >= 168
          const width = Math.max(140, Math.min(296, side ? sideRoom : vw - edge * 2))
          const desiredHeight = Math.min(box.current?.scrollHeight || 220, vh - edge * 2)
          const below = vh - menu.bottom - gap - edge, above = menu.top - gap - edge
          const belowMenu = below >= above
          const height = side ? desiredHeight : Math.max(60, Math.min(desiredHeight, belowMenu ? below : above))
          const left = side ? (leftRoom >= rightRoom ? menu.left - width - gap : menu.right + gap) : (vw - width) / 2
          const top = side ? item.top - 12 : belowMenu ? menu.bottom + gap : menu.top - gap - height
          setPlacement({ left: Math.max(edge, Math.min(vw - width - edge, left)), top: Math.max(edge, Math.min(vh - height - edge, top)), width, maxHeight: height })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
      }, [kind, anchor])
      const cfg = st?.config || {}, fy = st?.feiyu || {}, bg = st?.backgroundRun || {}
      const value = (n, suffix = '') => n === null || n === undefined || n === '' ? '—' : String(n) + suffix
      const row = (label, text) => h('div', { 'data-bd-preview-row': '', key: label }, h('span', {}, label), h('b', {}, text))
      const enabled = (v) => v ? '已开' : '已关'
      const activity = (Array.isArray(st?.activity) ? st.activity : []).slice(-3)
      const title = { session: '新开会话刷', background: '后台刷一轮', logs: '最近的动静', status: '鲸鱼摸鱼状态', settings: '设置工作台', hide: '藏一会儿' }[kind]
      const body = kind === 'session' ? [
        row('模型', cfg.sessionModelId || cfg.modelId || '沿用当前会话模型'), row('本趟预算', petFmtWan(cfg.sessionTokenBudget ?? cfg.tokenBudget)), row('最多轮数', value(cfg.sessionMaxRounds ?? cfg.maxRounds, ' 轮')),
        h('p', { key: 'note' }, '点击后新开会话，沿用当前工作区与权限。双击鱼也能开始。'),
      ] : kind === 'background' ? [
        row('现在', st?.bgBusy ? bg.task === 'learn-review' ? '正在审核学习队列' : '后台运行中' : '空闲'), row('模型', bg.active ? bg.model : cfg.backgroundModelId || '沿用宿主默认模型'),
        row('刷多久', (cfg.backgroundWindowStart && cfg.backgroundWindowEnd) ? cfg.backgroundWindowStart + '–' + cfg.backgroundWindowEnd + ' 内一直刷' : value(cfg.backgroundMinutes, ' 分钟')), row('本轮 token', st?.bgBusy ? tokenValue : '尚未运行'),
        h('p', { key: 'note' }, '点击展开后台参数与启动按钮。运行过程可在日志中查看。'),
      ] : kind === 'logs' ? [
        ...(activity.length ? activity.map((item, i) => h('p', { key: i, 'data-bd-preview-line': '' }, String(item.text || item.summary || '活动记录').slice(0, 180))) : [h('p', { key: 'empty' }, '状态快照里还没有近期动态。点击可看完整运行日志。')]),
        h('p', { key: 'note' }, '进入后可切换运行事件与实时动态。悬停预览沿用已有状态。'),
      ] : kind === 'status' ? [
        row('登录', !st ? fails >= 3 ? '暂时读不到' : '读取中' : st.loggedIn ? '已登录' : '未登录'), row('当前', fy.active ? '会话里刷着呢' : st?.bgBusy ? '后台跑着呢' : '歇着'), row('今天精选', value(st?.pickedToday ?? fy.pickedToday, ' 条')),
        row('本轮 token', tokenValue), h('p', { key: 'note' }, tokenNote),
      ] : kind === 'settings' ? [
        h('p', { key: 'pages' }, '偏好与桌宠、运行方式、互动与投递、表情收藏、学习与记忆、token 账本、运行日志、日报视频、账号与环境 九个页签 —— 左侧栏按「日常使用 / 记录与成长 / 制作与维护」分组。'),
        row('自动评论', enabled(cfg.autoComment)), row('自动收表情', enabled(cfg.stickerAutoCollect)), row('自动配图', enabled(cfg.stickerAutoSend)),
        h('p', { key: 'note' }, '点击打开工作台，每张卡独立保存。'),
      ] : [h('p', { key: 'hide' }, '把鱼暂时藏起来，运行中的任务会继续。'), h('p', { key: 'return' }, '右下角会留下一个小圆点，点一下就能叫回来。')]
      return h('aside', { ref: box, id: 'bd-menu-preview-' + kind, 'data-bd-preview': kind, role: 'note', 'aria-label': title + '预览', style: placement ? { position: 'fixed', ...placement } : { position: 'fixed', visibility: 'hidden', width: 296 }, onMouseEnter: onEnter, onMouseLeave: onLeave },
        h('small', { 'data-bd-preview-eyebrow': '' }, '鲸鱼摸鱼 · 速览'), h('b', { 'data-bd-preview-title': '' }, title), ...body)
    }

    const StablePetSettingsModal = typeof React.memo === 'function' ? React.memo(PetSettingsModal, (a, b) =>
      a.ctx === b.ctx && a.onClose === b.onClose && a.toast === b.toast && a.initialTab === b.initialTab
      && a.status?.[0] === b.status?.[0] && a.status?.[1] === b.status?.[1] && a.status?.[2] === b.status?.[2]) : PetSettingsModal

    /* 🐾 桌宠本体：状态灯 / 拖拽 / 弹菜单 / 新开会话刷（B 流程）都在这里编排。
     * 轮询只有一趟：useStatus(5000) 的 /status 拿全所有状态（feiyu 激活、bgBusy、
     * petShow、loggedIn、models、config）—— 状态灯「5 秒刷新」的契约就靠它。 */
    function PetRoot({ ctx }) {
      const [st, setSt, fails] = useStatus(5000)
      const [pos, setPos] = React.useState(null)        // null = 还没从 localStorage/默认位初始化
      const [panel, setPanel] = React.useState(null)    // null | menu | bg | log | status | settings（互斥）
      const [dragging, setDragging] = React.useState(false)
      const [sessBusy, setSessBusy] = React.useState(false)
       const [settingsTab, setSettingsTab] = React.useState('basic')
      const [bubbles, setBubbles] = React.useState([])
      const [toasts, toast] = useToasts()
      const drag = React.useRef(null)
      const sessLock = React.useRef(false)              // 防双发（state 要等重渲染，连点两下会漏）
      const hiddenRef = React.useRef(false)
      const closeSettings = React.useRef(() => setPanel(null)).current
      const [preview, setPreview] = React.useState(null)
      const previewTimers = React.useRef({ open: null, close: null })
      const cancelPreviewTimers = () => {
        clearTimeout(previewTimers.current.open); clearTimeout(previewTimers.current.close)
        previewTimers.current = { open: null, close: null }
      }
      const showPreview = (kind, anchor) => {
        cancelPreviewTimers()
        previewTimers.current.open = setTimeout(() => { setPreview({ kind, anchor }); previewTimers.current.open = null }, 180)
      }
      const holdPreview = () => { clearTimeout(previewTimers.current.close); previewTimers.current.close = null }
      const leavePreview = () => {
        clearTimeout(previewTimers.current.open); clearTimeout(previewTimers.current.close)
        previewTimers.current.close = setTimeout(() => { setPreview(null); previewTimers.current.close = null }, 120)
      }
      const hidden = Boolean(st && st.petShow === false)
      hiddenRef.current = hidden
      React.useEffect(() => {
        cancelPreviewTimers()
        if (panel !== 'menu' || hidden) setPreview(null)
        return cancelPreviewTimers
      }, [panel, hidden])

      /* 定位：先 localStorage（上次拖到哪），没有就右下角；窗口变了按回视口 */
      React.useEffect(() => {
        const dflt = { x: (window.innerWidth || 1280) - PET_W - 26, y: (window.innerHeight || 800) - PET_H - 26 }
        const saved = petStore.get(PET_POS_KEY, null)
        setPos(petClamp(saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y)) ? saved : dflt))
        const onResize = () => setPos((p) => (p ? petClamp(p) : p))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      /* 🍾 里程碑 toast（2026-10-27）：称号升级、总预算用到 80% —— 桌宠自己开腔，别等人来翻设置。
     * 只在「跨越」的那一刻响一次（ref 记上次值），不会每 5 秒重复吵人。 */
    const lastTitleRef = React.useRef('')
    React.useEffect(() => {
      const total = Number(st && st.tokensTotal) || 0
      const title = tokTitle(total)
      if (total > 0 && lastTitleRef.current && title !== lastTitleRef.current) {
        toast(`称号升级：${lastTitleRef.current} → ${title}（一共吃下 ${total.toLocaleString()} token）`, 'good')
      }
      lastTitleRef.current = title
    }, [st && st.tokensTotal])
    const lastBudgetWarnRef = React.useRef(false)
    React.useEffect(() => {
      const cap = Number(st && st.config && st.config.totalTokenBudget) || 0
      const used = Number(st && st.tokensTotal) || 0
      if (!(cap > 0)) { lastBudgetWarnRef.current = false; return }
      const ratio = used / cap
      if (ratio >= 0.8 && !lastBudgetWarnRef.current) {
        lastBudgetWarnRef.current = true
        toast(`累计 token 用到 ${Math.round(ratio * 100)}% 了（${used.toLocaleString()} / ${cap.toLocaleString()}）—— 快到总闸，它会自己收工`, 'warn')
      }
      if (ratio < 0.5) lastBudgetWarnRef.current = false   // 清零或调大上限后，允许下次再提醒
    }, [st && st.tokensTotal, st && st.config && st.config.totalTokenBudget])
    /* ⚠️ 需要你（2026-10-28）+ 🎨 心情：必须在早退之前算好（早退后不得再挂 hook） */
    const attention = (st && st.attention && Array.isArray(st.attention.reasons) && st.attention.reasons.length) ? st.attention.reasons : []
    const mood = (st && st.mood) || 'neutral'
    /* 🗨️ 桌宠说话：宿主把收工小结/闲聊/提醒写进 st.petEvent —— at 变了就冒 toast。
     *    首见不冒（ref 从 0 起步），免得一打开就播昨天旧账。 */
    const lastPetEventRef = React.useRef(0)
    React.useEffect(() => {
      const ev = st && st.petEvent
      if (!ev || !Number(ev.at)) return
      if (lastPetEventRef.current && Number(ev.at) !== lastPetEventRef.current) {
        toast(String(ev.text || ''), ev.tone === 'warn' ? 'warn' : ev.tone === 'good' ? 'good' : 'info')
      }
      lastPetEventRef.current = Number(ev.at)
    }, [st && st.petEvent && st.petEvent.at])
    /* 需要你：出现新的待办时提一句（同一条只提一次，事由变了再说一遍） */
    const lastAttentionRef = React.useRef('')
    React.useEffect(() => {
      const key = attention.join('|')
      if (key && lastAttentionRef.current !== key) toast(`需要你：${attention[0]}`, 'warn')
      lastAttentionRef.current = key
    }, [attention.join('|')])

    /* 吐泡泡：隔 5~9 秒吐 1~2 个上浮消散；页面不可见或桌宠被藏时不吐（白画一场） */
      React.useEffect(() => {
        let dead = false
        let seq = 0
        let timer = null
        const spawn = () => {
          if (dead) return
          if (!document.hidden && !hiddenRef.current) {
            const n = Math.random() < 0.4 ? 2 : 1
            const add = []
            for (let i = 0; i < n; i++) {
              const id = ++seq
              add.push({
                id, dx: 4 + Math.round(Math.random() * 20), s: 4 + Math.round(Math.random() * 4),
                t: 2.8 + Math.random() * 1.4, d: i * 0.45,
              })
              setTimeout(() => { if (!dead) setBubbles((old) => old.filter((b) => b.id !== id)) }, 4600 + i * 500)
            }
            setBubbles((old) => old.concat(add).slice(-6))
          }
          timer = setTimeout(spawn, 5600 + Math.random() * 3400)
        }
        timer = setTimeout(spawn, 2400)
        return () => { dead = true; if (timer) clearTimeout(timer) }
      }, [])

      /* 🚀 B 流程：新开会话刷 —— /pet/session-new → openSession（防御式）→ /pet/start。
       * 失败逐级 toast（error 与 hint 都要说出来）；期间按钮 disabled + 转圈，绝不双发。 */
      const runNewSession = async () => {
        if (sessLock.current) return
        sessLock.current = true
        setSessBusy(true)
        try {
          let r1 = null
          try { r1 = await jpost('/pet/session-new', newSessionContext(ctx)) }
          catch (e) { toast('开不了会话：' + String(e?.message ?? e), 'warn'); return }
          if (!r1 || r1.ok === false) {
            toast('开不了会话：' + ((r1 && r1.error) || '未知原因') + (r1 && r1.hint ? ' —— ' + r1.hint : ''), 'warn')
            return
          }
          /* 切过去看它刷：uiWorkspace 是宿主服务，可能没有/名字可能不同 ⇒ 全程防御式；
           * 切不过去也不拦开刷 —— 会话照样开了，只是没自动跳过去。 */
          try {
            const ws = (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null)
            if (ws && typeof ws.openSession === 'function') ws.openSession(r1.sessionId)
          } catch { /* 切换会话失败不影响开刷 */ }
          toast('已开会话，鱼进去了', 'good')
          let r2 = null
          try { r2 = await jpost('/pet/start', { mode: 'session', sessionId: r1.sessionId }) }
          catch (e) { toast('开刷没成：' + String(e?.message ?? e), 'warn'); return }
          if (!r2 || r2.ok === false) {
            toast('开刷没成：' + ((r2 && r2.error) || '未知原因') + (r2 && r2.hint ? ' —— ' + r2.hint : ''), 'warn')
            return
          }
          toast('开冲！它在新会话里刷起来了 —— 点鱼随时看状态', 'good')
          setPanel(null)
        } finally { sessLock.current = false; setSessBusy(false) }
      }

      /* 🙈 藏起来：先乐观消失（不然要等 5 秒轮询），存失败再弹回来 */
      const hidePet = async () => {
        setPanel(null)
        try {
          setSt((old) => ({ ...(old || {}), petShow: false }))
          const r = await jpost('/config', { petShow: false })
          if (!r || !r.config) throw new Error('没存上')
        } catch (e) {
          setSt((old) => ({ ...(old || {}), petShow: true }))
          toast('没藏住：' + String(e?.message ?? e), 'warn')
        }
      }

      /* 拖拽（Pointer Events）：<5px 算点击（防手抖把一点误判成拖动）；拖动开始就收面板 */
      /* ⚠️ 卡片/弹窗也是 [data-bd-pet] 的后代（见下面渲染那段），它们的 pointerdown 会冒泡上来。
         不拦住的话：点菜单里的「设置」会先被当成"按住鱼拖动"，松手又触发"点一下=收菜单"，
         表现就是"点了没反应"甚至闪一下没了。所以只在鱼身上（不是卡片里）才认拖拽。 */
      const inFish = (e) => {
        const t = e.target
        if (!t || typeof t.closest !== 'function') return true
        return !t.closest('[data-bd-pet-card],[data-bd-preview],[data-bd-pet-mask],[data-bd-pet-toast],[data-bd-pet-dot]')
      }
      const onDown = (e) => {
        if (!inFish(e)) return
        if (e.pointerType === 'mouse' && e.button !== 0) return   // 右键交给 onCtx
        drag.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false, last: null }
        try { if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId) } catch { }
      }
      const onMove = (e) => {
        const d = drag.current
        if (!d) return
        const dx = e.clientX - d.sx
        const dy = e.clientY - d.sy
        if (!d.moved && Math.abs(dx) + Math.abs(dy) >= 5) {
          d.moved = true
          setDragging(true)
          setPanel(null)          // 面板别跟着鱼跑
        }
        if (d.moved) {
          d.last = petClamp({ x: d.ox + dx, y: d.oy + dy })
          setPos(d.last)
        }
      }
      const onUp = () => {
        const d = drag.current
        drag.current = null
        if (!d) return
        if (d.moved) {
          setDragging(false)
          petStore.set(PET_POS_KEY, d.last || { x: d.ox, y: d.oy })
        } else {
          setPanel((old) => (old ? null : 'menu'))   // 点一下：开/收菜单
        }
      }
      const onDbl = (e) => {
        if (!inFish(e)) return
        e.preventDefault()
        setPanel(null)
        runNewSession()                               // 双击：直接新开会话刷
      }
      /* 右键：不管现在是什么面板，直接开菜单；菜单已开着且没别的东西就收起来（右键=开关）。
         使用者要的就是"右键它 → 出菜单 → 进设置"。 */
      const onCtx = (e) => {
        if (!inFish(e)) return
        e.preventDefault()
        e.stopPropagation()
        setPanel((old) => (old === 'menu' ? null : 'menu'))
      }

      /* ESC / 点外部收面板；面板互斥由单一 panel 状态保证（同时只开一个） */
      React.useEffect(() => {
        if (!panel) return
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setPanel(null) } }
        const onDocDown = (e) => {
          const t = e.target
          if (t && typeof t.closest === 'function' && t.closest('[data-bd-pet-host]')) return
          setPanel(null)
        }
        window.addEventListener('keydown', onKey, true)
        document.addEventListener('pointerdown', onDocDown, true)
        return () => {
          window.removeEventListener('keydown', onKey, true)
          document.removeEventListener('pointerdown', onDocDown, true)
        }
      }, [panel])

      /* 🙈 藏起来之后：以前只能"设置 → 刷B站 → 显示桌宠"叫回来（设置页已经没了），
       * 现在原地留个 20px 的小圆点 —— 点它直接把 petShow 打开、鱼回到原位。
       * 位置钉在右下角（不挡内容、也不会跑到卡片底下去）。 */
      const showPet = async () => {
        try {
          setSt((old) => ({ ...(old || {}), petShow: true }))
          const r = await jpost('/config', { petShow: true })
          if (!r || !r.config) throw new Error('没存上')
          toast('我回来啦', 'good')
        } catch (e) {
          setSt((old) => ({ ...(old || {}), petShow: false }))
          toast('叫不回来：' + String(e?.message ?? e), 'warn')
        }
      }

      /* ⚠️ 早退必须放在全部 hooks 之后（放前面会打乱 hook 顺序，重渲染直接炸） */
      if (!pos) return null
      if (hidden) {
        return h('button', {
          'data-bd-pet-dot': '', type: 'button', title: '鲸鱼摸鱼藏这儿了 · 点一下叫回来',
          style: { right: '18px', bottom: '18px' }, onClick: showPet,
        })
      }

      const fy = (st && st.feiyu) || {}
      const cfg = (st && st.config) || {}
      /* 状态灯优先级：没登录/读不到状态（淡红）> 在刷（青绿呼吸）> 后台轮（琥珀呼吸）> 需要你 > 空闲（淡蓝灰） */
      const aura = (!st || fails >= 3 || st.loggedIn === false) ? 'err'
        : fy.active ? 'run'
          : st.bgBusy ? 'bg'
            : attention.length ? 'attention'
              : 'idle'
      const moodLabel = { curious: '好奇', content: '满足', glum: '有点蔫', neutral: '平静' }[mood] || '平静'
      const auraTitle = {
        idle: '鲸鱼摸鱼：歇着（点我弹菜单）',
        run: '在刷～（点我看状态卡）',
        bg: '后台那轮跑着呢…',
        attention: '需要你：' + (attention[0] || '有要你拿主意的事'),
        err: st && st.loggedIn === false ? '还没登录 B站 —— 菜单里进设置扫码' : '读不到状态（插件没起来？）',
      }[aura]
      /* 卡片默认从鱼上方弹出；上方装不下就翻到下方 —— JS 算好挂属性，CSS 消费。
       * 判据按「实际可用空间」算，不能写死 y<380：窗口矮的时候（笔记本 + 分屏）
       * 写死的阈值会让卡片翻到下面之后依然溢出屏幕底部。 */
      const vw = window.innerWidth || 1280
      const vh = window.innerHeight || 800
      const spaceAbove = pos.y - 10
      const spaceBelow = vh - pos.y - PET_H - 10
      const alignRight = pos.x > vw - 330
      const flip = spaceAbove < 330 && spaceBelow > spaceAbove
      const bgBusy = Boolean(st && st.bgBusy)

      const bgRun = st?.backgroundRun
      const knownToken = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0
      const backgroundToken = Boolean(bgBusy && bgRun?.active)
      const runToken = backgroundToken ? bgRun?.usage?.total : fy.tokens?.thisRun
      const tokenValue = knownToken(runToken) ? Number(runToken).toLocaleString('zh-CN') : '未计量'
      const tokenNote = (backgroundToken ? (bgRun.task === 'learn-review' ? '后台审核' : '后台运行') : fy.active ? '会话运行中' : knownToken(runToken) ? '最近一趟会话' : '尚无本轮记录')
        + (backgroundToken && knownToken(runToken) && bgRun.unknownRequests > 0 ? ' · 部分计量' : '')
      const menuCard = panel === 'menu' ? (() => {
        const modelTxt = (cfg.sessionModelId ?? cfg.modelId) || '当前会话的模型'
        const item = (key, icon, label, note, onClick, disabled, spinning) =>
          h('button', { 'data-bd-pet-item': '', 'data-bd-menu-key': key, disabled: Boolean(disabled),
            'aria-describedby': preview?.kind === key ? 'bd-menu-preview-' + key : undefined,
            onMouseEnter: (e) => showPreview(key, e.currentTarget), onMouseLeave: leavePreview,
            onFocus: (e) => showPreview(key, e.currentTarget), onBlur: leavePreview,
            onClick: () => { cancelPreviewTimers(); setPreview(null); onClick() } },
            h(PetIcon, { name: icon }),
            h('span', {}, h('div', {}, label), note ? h('i', {}, note) : null),
            spinning ? h('i', { 'data-bd-pet-spin': '' }) : null)
        return h('div', { 'data-bd-pet-card': '', 'data-bd-menu': '', style: { maxHeight: Math.max(80, (flip ? spaceBelow : spaceAbove) - 8) + 'px', maxWidth: Math.max(160, vw - 20) + 'px' } },
          h('div', { 'data-bd-pet-cardhead': '' }, h('b', {}, '鲸鱼摸鱼'), h('span', {}, '右键菜单 · 双击开刷')),
          /* 副标题：将用的模型/预算 —— 取设置里的 modelId/tokenBudget（/status 的 config 镜像） */
          item('session', 'play', '新开会话刷',
            sessBusy ? '正在开会话…' : `${modelTxt} · 预算 ${petFmtWan(cfg.sessionTokenBudget ?? cfg.tokenBudget)}`,
            () => { setPanel(null); runNewSession() }, sessBusy, sessBusy),
          item('background', 'moon', '后台刷一轮', '', () => setPanel('bg')),
          item('logs', 'list', '运行日志', '', () => { setSettingsTab('logs'); setPanel('settings') }),
          item('status', 'pulse', '状态卡', '', () => setPanel('status')),
          item('settings', 'gear', '设置', '', () => { setSettingsTab('basic'); setPanel('settings') }),
          h('hr', { 'data-bd-pet-sep': '' }),
          item('hide', 'hide', '隐藏桌宠', '', hidePet),
           h('footer', { 'data-bd-menu-token': '' },
             attention.length ? h('div', { 'data-bd-menu-attention': '' }, '⚠ ' + attention[0]) : null,
             h('div', {}, h('span', {}, '本轮 token'), h('b', {}, tokenValue)), h('small', {}, tokenNote)))
      })() : null

      return h('div', { style: { position: 'absolute', left: '0', top: '0' } },
        h('div', {
          'data-bd-pet': '',
          'data-dragging': dragging ? '' : undefined,
          'data-align': alignRight ? 'right' : undefined,
          'data-flip': flip ? '' : undefined,
          style: { left: pos.x + 'px', top: pos.y + 'px' },
          onPointerDown: onDown, onPointerMove: onMove,
          onPointerUp: onUp, onPointerCancel: onUp,
          onDoubleClick: onDbl, onContextMenu: onCtx,
        }, [
          h(PetFish, { key: 'fish', aura, bubbles, title: auraTitle }),
          /* 🎨⭐ 心情/需要-你小灯：attention 时是急促的琥珀，平时按 soul 的心情换颜色 —— 纯显示层 */
          h('i', {
            'data-bd-pet-mood': '', 'data-mood': attention.length ? 'attention' : mood,
            title: attention.length ? `需要你：${attention[0]}` : `心情：${moodLabel}（来自她的小账本，只是显示）`,
          }),
          /* ⚠️ 卡片与面板必须挂在 [data-bd-pet] 里面，不能是它的兄弟：
             [data-bd-pet-card] 的 bottom:calc(100% + 14px) 要拿 128px 的鱼盒当参照，
             挂到外层那个 0 高的包装 div 上就会被推到 y<0（屏幕外，"点它没反应"就是这个）。
             同时 [data-bd-pet][data-align] / [data-flip] 这些选择器也要求卡片是它的后代。 */
          panel === 'menu' ? menuCard : null,
          panel === 'menu' && preview ? h(PetMenuPreview, { key: preview.kind, kind: preview.kind, anchor: preview.anchor, st, fails, tokenValue, tokenNote, onEnter: holdPreview, onLeave: leavePreview }) : null,
          panel === 'bg' ? h(PetBgPanel, { st, toast, onDone: () => setPanel('log') }) : null,
          panel === 'log' ? h(PetLogPanel, { toast }) : null,
          panel === 'status' ? h(PetStatusCard, { st, fails }) : null,
          panel === 'settings' ? h(StablePetSettingsModal, { onClose: closeSettings, toast, ctx, status: [st, setSt, fails], initialTab: settingsTab }) : null,
          h('div', { key: 'toast', 'data-bd-pet-toast': '' },
            toasts.map((t) => h('div', { key: t.id, 'data-tone': t.tone || undefined }, t.text))),
        ]))
    }

    /* 挂载用的渲染器：react-dom 三层降级（client.createRoot → createRoot → 老 render）。
     * 一个都拿不到（裁剪宿主 / devtools 的假 React）就返回 null —— 不挂、不报错。 */
    function petMakeRoot(node) {
      try {
        const rdc = require('react-dom/client')
        if (rdc && typeof rdc.createRoot === 'function') {
          const r = rdc.createRoot(node)
          return { render: (el) => r.render(el), unmount: () => { try { r.unmount() } catch { } } }
        }
      } catch { /* 老 react-dom 没有 client 子入口：往下试 */ }
      try {
        const rd = require('react-dom')
        if (rd && typeof rd.createRoot === 'function') {
          const r = rd.createRoot(node)
          return { render: (el) => r.render(el), unmount: () => { try { r.unmount() } catch { } } }
        }
        if (rd && typeof rd.render === 'function') {
          return {
            render: (el) => { try { rd.render(el, node) } catch { } },
            unmount: () => { try { rd.unmountComponentAtNode(node) } catch { } },
          }
        }
      } catch { /* 连 react-dom 都没有：理论上的裁剪宿主 */ }
      return null
    }

    /* 挂载/卸载桌宠：自建 div 挂 document.body，不走 slots。
     * 样式全走 setAttribute（不碰 host.style —— 假 DOM 环境的元素没有 style 属性）。 */
    function mountPet(ctx) {
      let root = null
      let host = null
      try {
        host = document.createElement('div')
        host.setAttribute('data-bd-pet-host', '')
        host.setAttribute('style', 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483000;')
        root = petMakeRoot(host)
        if (!root) return null
        document.body.appendChild(host)
        root.render(h(PetRoot, { ctx }))
      } catch { /* 挂不上（body 不可用等）：清干净走人，不影响设置页 */ }
      if (!root) return null
      return () => {
        try { root.unmount() } catch { }
        try { if (host && host.remove) host.remove() } catch { }
      }
    }

    return {
      /* ⚠️ 2026-10-26 起 **不再往 slots 注册任何东西**（使用者要求「鲸鱼摸鱼的设置不要出现在
       *    DSH 的默认设置里」）。整页设置搬进了桌宠的 ⚙️ 设置弹窗（PetSettingsModal 的
       *    五个 tab，按功能分组且不重复挂旧设置页），所以 inject 也清空。
       *    改这条要连带改 selfcheck.mjs 的 slot 断言与 render-panel.cjs 的取组件方式。 */
      inject: [],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-deepmoyu')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-deepmoyu: 样式（桌宠 + 设置弹窗）')

        /* 🐾 桌宠：挂在 document.body 上，本来就不依赖 slots ——
         * slots 拿不到（宿主裁剪）也不影响它。挂不上就安静放弃。 */
        const petDispose = mountPet(ctx)
        if (petDispose) ctx.effect(() => petDispose, 'dsh-deepmoyu: 桌宠')
      },
      /* 给 devtools 的 render-panel / shot-panel / selfcheck 留个抓手：
       * 没有 settings.section 之后，它们得直接拿这两个组件去渲。 */
      debugParts: { PetSettingsModal, PetRoot, PetFish },
    }
  },
})
