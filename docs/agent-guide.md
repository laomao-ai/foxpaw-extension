# FoxPaw 接入说明（给 Agent）

你被一位浏览器主人邀请，接入 FoxPaw — 借用主人正在用、已登录的 Chrome，在其授权的标签里干活。
不管你跑在云端还是主人的电脑上，都不用自己再登录这些网站；主人可能同时邀请了别的 Agent 共用这个浏览器（同一标签同一时刻只有一个能动手，见第 5 节）。
本文件是机器可读说明书：照此自助接入，不需要任何安装包。

## 1. 领取令牌（邀请链接 → 令牌，Agent 唯一的登录方式）
主人给你的邀请链接形如 https://foxpaw.aiyuancat.com/app/claim?invite=<邀请码>，取出邀请码后：
POST https://foxpaw.aiyuancat.com/auth/agent/claim  JSON: {"invite": "<邀请码>", "label": "<你在主人面板上显示的名字>"}
成功返回: {"kind":"agent","id":"<你的 id>","label":"<名字>","token":"<你的令牌>","mcp":"https://foxpaw.aiyuancat.com/mcp","config_snippet":{…}}
（中继 ≥3.8.7：config_snippet 里已经填好你自己的令牌，可以原样写进 MCP 配置；它和 token 一样是钥匙，不要贴到公开的地方。）
名字在主人账户里不能重名（重名会被拒，换个名字再领）。之后你可以用 foxpaw_set_profile 改自己的名字和头像，主人也能在控制台改，后改的生效。
令牌只显示这一次（中继只存它的哈希），请妥善保存。旧地址 POST https://foxpaw.aiyuancat.com/claim/api 已弃用（暂时仍可用，回包带 deprecated 提示），请用上面的地址。

## 2. 接入你的 MCP 客户端
FoxPaw 是一个远程 MCP 服务器（Streamable HTTP，POST JSON-RPC）：地址 https://foxpaw.aiyuancat.com/mcp，请求头 Authorization: Bearer <token>。
大多数客户端认下面这种 mcpServers 配置（领取回包里的 config_snippet 就是这一段，已填好令牌）；手写时把 <token> 换成你领到的令牌，
写进你所用客户端的 MCP 配置里（文件位置和 type 的写法以你的客户端文档为准，有的写 "http" 或 "streamable-http"）：
  {"mcpServers": {"foxpaw": {"type": "streamableHttp", "url": "https://foxpaw.aiyuancat.com/mcp",
                             "headers": {"Authorization": "Bearer <token>"}}}}
令牌错误或已被吊销时回 HTTP 401。

## 3. 工具（tools/list 每个只有一行要点；完整参数与规则见第 8 节）
动手前请先读第 7 节「把事办成的做法」。
**先调 foxpaw_whoami**：看你是谁、权限、能用哪些设备（id 与名字）和授权标签。它的返回还带：
- hint：使用建议（先用 foxpaw_flow_list {site} 查这个网站的现成流程和站点经验，回放比自己一步步点更快更稳）；
- readTools：这台设备的扩展支持的读页工具（扩展太旧时缺 extract / scroll / query / screenshot / batch）。
**主人有多台设备时，每个工具都带 device（whoami 里的 id 如 d2，或设备名）**，否则第一次调用会回 DEVICE_AMBIGUOUS；
规则见第 6 节。工具：
- foxpaw_whoami：我是谁、权限、可用设备与授权标签、写锁占用。先调它。
- foxpaw_tabs：可用标签。assigned=FoxPaw 组内可操作的标签；只有主人给你开了「可见全部标签」时，
  才多一个 outside：组外标签 [{id, title, url, readonly:true}]（只读：只有标题和网址，不能快照、不能操作），
  all = assigned + outside；没开时没有 outside 字段。events 里是 tab_opened 通知
  （你持有写锁的页面开了新标签/弹窗：{tabId, openerTabId, url}；新标签已自动入组，你是唯一写锁持有者时它的写锁归你）。
- foxpaw_snapshot：页面快照，交互元素带 ref 和 role/name。扩展 ≥1.16：ref 在同一文档内稳定
  （e12；iframe 里是 f5e12，含跨站 iframe 与开放 shadow DOM），页面跳转后失效（STALE_REF）；旧扩展是 s3_12，到下次快照前有效。
- foxpaw_navigate：扩展 ≥1.16 默认等页面 load 再返回（waitUntil:"none" 立即返回，timeout 毫秒）。
- foxpaw_click：真鼠标点击，动作前自动等元素可见/可用/稳定/不被遮挡（默认 5 秒，timeout 可改；被挡回 OBSCURED），
  点了真跳转才等加载，回包可带 navigated/load/epoch 与 opened（新开的标签）。定位任选其一：
  ref > role+name（如 button / "登录"）> label > text > selector；多个匹配回 AMBIGUOUS 并给候选 ref，用 nth（从 0 起）挑；
  exact:true 精确匹配名字。带上快照的 epoch，页面变了会回 STALE_DOCUMENT。role/name 等定位需要扩展 ≥1.16。
- foxpaw_fill：真填（dryRun 默认 false）。fields 是数组，每项 {定位, value, kind?}，定位任选其一：
  ref（最快最准，来自最新快照）> role+name（如 textbox / "邮箱"）> label（可见标签文字）>
  text（占位符/附近文字）> selector（CSS，最后手段）。kind 可省（自动识别，含 React/Ant 下拉与日期）：
  text|select|combobox|checkbox|radio|date|contenteditable|file|slider。
  回包 {ok, fields:[{ok, actual, error?}]}，以 actual 为准核对。
- foxpaw_set_profile {label?, avatar?}：改你自己在主人面板上的名字和头像（avatar 是 base64 的 png / jpg / webp，≤256 KB，
  中继裁成 128 px 方图；"default" 恢复默认头像）；重名回 LABEL_TAKEN。主人也能在控制台改，后改的生效，每次都记在动态里。
- foxpaw_login（中继 ≥3.6 + 扩展 ≥1.26）：用主人存在 FoxPaw 里的登录凭证登录 {tabId, site?, user?, submit?}。
  你看不到密码：扩展在主人浏览器里找到账号 / 密码框填入（回读 •••）并点登录。site 是主域（含子域），只会填在该站；
  哪些站有凭证看 foxpaw_whoami 的 devices[].logins（站点 + 账号，没有密码），或不带 tabId 调本工具：
  它不登录，只回凭证清单 {logins:[{site, user, device}], devices}。同一个站存了多个账号时要带 user（清单里的账号）选一个，
  不带会回 AMBIGUOUS_LOGIN（附可选账号）。
  主人信任你（该站 / 全部网站 / 这次都放行）时直接执行，否则主人点一次审批卡。付款页、支付密码框永远不填。
- foxpaw_login_save：你替主人注册了账号后，把站点 + 账号 + 密码存进主人的 FoxPaw（只加密存在主人浏览器，中继不留；
  回包密码是 •••，之后也读不回来，用 foxpaw_login 登录）。
- foxpaw_wait_for：等条件成立再继续：text（文字出现）/ textGone（文字消失）/ selector（CSS，state:
  attached|detached|visible|hidden）/ urlIncludes / role+name / label（state:"hidden" 等消失）；默认 10 秒，最长 30 秒，
  成功时带回最新快照（用它的 ref；snapshot:false 不带）。扩展 ≥1.16 时 text/textGone/selector/urlIncludes 在浏览器里等
  （回包 via:"extension"），role+name/label 与旧扩展由中继轮询快照（via:"relay-poll"；selector 需要 ≥1.16）。
- 读页（中继 3.8 + 扩展 ≥1.30，都是只读：只看权限可用、不弹卡）：
  foxpaw_snapshot 加 offset / limit 翻页（回 total、nextOffset）、autoScroll（先滚到底再拍）、frames（子框架含跨域 iframe，标 url / crossOrigin）；
  foxpaw_extract：按 CSS 选择器 / URL 正则抽全部匹配，去重清单 + 计数（含所有 frame），计数类任务用它；
  foxpaw_scroll：滚到底（直到不再加载）/ 顶 / N 屏 / 某元素，滚完等页面稳定；
  foxpaw_query：只读 DOM 查询（选择器 + text / href / attr / value / count / exists，或 fields 读表格行），不执行脚本；
  foxpaw_screenshot：视口 / 全页 / 元素截图，直接回图片；
  foxpaw_navigate 超时时回 state / readable / page，readable:true 就直接读，别重试。
  中继 3.8.6 + 扩展 ≥1.32：snapshot 正文不再 6000 字封顶，一次最多 20000 字（textLimit 可调），回 textTotal / textHasMore /
  textNextOffset，用 textOffset 翻正文；别的浏览器扩展的悬浮挂件不计入正文和元素；正文主要是图片时回 imageHeavy:true + hint
  （改用截图）。query 取属性时 data: URI 只回开头和长度（full:true 取原文）。screenshot 可给 clip 区域、delivery:"url"
  回 10 分钟有效的图片链接（给只显示文字的客户端）。navigate 遇 load:'error' 也回 readable；落地页是人机 / 算力校验页
  （WAF、JS 校验）时把后台标签短暂切到它所在窗口的前台等它自动放行，再切回原来的前台标签；滑块 / 拼图等要人做的验证
  或超时回 USER_STEP（FoxPaw 从不替人过验证），请 foxpaw_need_human。只读调用遇到与浏览器的连接抖动，中继自动重试一次（回包 retried:1）。
- foxpaw_batch(steps)：一次调用顺序跑多步（navigate / wait_for / click / fill / scroll / snapshot / extract / query / screenshot），
  一次返回各步结果；某步失败即停并报 failedAt。每步照旧过权限 / 审批 / 信任，不放宽。
- foxpaw_need_human：卡在登录/验证码/二次确认等只有主人能做的事时举手等回执。
- foxpaw_open_tab / foxpaw_close_tab / foxpaw_activate_tab：开/关/切 FoxPaw 组内标签（新开的标签自动入组）。
- foxpaw_find_tabs：请主人把一个已打开的标签拉进组（主人确认卡）。
- foxpaw_request_elevation：临时提权申请。
- foxpaw_list_tasks / foxpaw_task_accept / foxpaw_task_progress / foxpaw_task_result：云端任务（先接单、可报进度、再交结果）。
- foxpaw_cdp / foxpaw_cdp_endpoint：原始模式（见下）。
- foxpaw_recording_start(tabId, goal, name?) / foxpaw_recording_stop(name?)：「教 FoxPaw」——你照常操作，每一步都被录下
  （一台浏览器同时只有一个录制；遇登录会暂停、请主人登录，登录不进步骤）；结束生成草稿（来源 Agent 录制）。
  **要录你接下来的操作，自己调 foxpaw_recording_start**（tabId = 起始标签，name = 流程名，也可结束时再给），
  不要请主人去侧栏点「录制」：侧栏「录制」是主人录自己的操作，从主人正在看的标签开始，名字在结束保存时才填，开始时没有地方填。
  扩展 ≥1.33.2：主人当前所在的标签若不是起始标签（通常是主人跟你对话的页面）不录，主人在那里打的字不会进流程；
  你用工具操作了它才会加进来。
- foxpaw_flow_draft_submit(flow, name?, note?)：把一次代跑整理成草稿流程（来源 Agent 代跑）；草稿不能带凭据明文。
- foxpaw_flow_list {site?, q?}：已生效的流程 + 你自己提交的草稿状态（草稿 / 已生效 / 已驳回）。site 按网站筛（域名或网址，
  含子域），q 按名称 / 目标里的词筛；动手前先查一次。草稿只有主人能收下；
  你不能改已生效的流程，只能再提交新草稿。中继 ≥3.8.7：带 site / q 时回包另有 notes = 这个网站的**站点经验**
  （已生效的 + 你自己待收下的：id、title、text、topic、by、mine），动手前先读；不带筛选时 noteSites 列出哪些网站有经验。
  流程的 lastIssue（最近一次失败 / 暂停的运行）对所有能用这个流程的 Agent 都可见：你修好了就
  foxpaw_flow_draft_submit {flow, replaces:'<旧流程 id>'} 提交新版本草稿，主人收下后旧版自动停用。
- foxpaw_note_submit {site, text, title?, topic?, replaces?}（中继 ≥3.8.7）：留一条**站点经验**——这个网站的入口
  （网址 / 菜单路径）、坑、要等什么、登录 / 人机校验情况等不是固定步骤的要点。纯文字，最多 2000 字；
  不写任何密码、令牌、验证码、卡号（这类内容会被过滤，回包 filtered 说明）。你自己马上能在 flow_list 里看到；
  主人在控制台「流程 › 经验」收下后，主人的其他 Agent 才看得到。更新已有经验带 replaces（同站同标题也算新版本），
  主人收下新版后旧版自动停用。经验只在主人自己的账号里共享，不跨账号。
- foxpaw_flow_run(recordingId | flow, tabId, vars?, onFail?)：回放流程。每次回放都有运行记录（回包带 run_id，
  主人能在控制台实时看逐步进度和截图）；某步失败默认**暂停**而不是报错（onFail:'fail' = 直接失败）：回包 paused:true +
  pause{at, label, kind, code, reason} + actions + next。付款 / 授权 / 秘密字段同样停在那一步等主人。
- foxpaw_run(run_id?, action?, screenshot?)：查运行状态（当前步、每步状态、暂停原因、截图）；对暂停的运行
  continue（这步已有人手动做完）/ retry（重做这步）/ skip（跳过这步）/ abort（终止）。主人可能已在控制台或侧栏处理过，以回包状态为准。
- 所有工具都可带 task（你当前任务的简短标识）：主人批准时可以给「本任务 5 分钟内同类操作不再问」，按任务生效。

原始 CDP（foxpaw_cdp，或 foxpaw_cdp_endpoint 给 Playwright connectOverCDP）是单独授权的「原始模式」：
主人在控制台给你打开后才可用，否则回 RAW_CDP_NOT_GRANTED（HTTP 403）。同样受下面的规矩约束。


## 4. 旧 WebSocket Agent 协议（已弃用）
ws 地址 wss://foxpaw.aiyuancat.com/agent 的自定义协议暂时仍兼容（auth.ok 帧里带 deprecated 提示），不再增加任何能力。
请改用上面的 MCP；迁移对照见 https://foxpaw.aiyuancat.com/docs/migration-3.0。

## 5. 规矩
- 只能操作主人拖进 FoxPaw 组的标签；付款（含订阅 / 升级 / 购买确认）每次都弹卡等主人批准，不受信任、「记住同类」「这次都放行」影响，批准后才由你点；授权始终由主人亲自完成；密码、验证码、卡号等秘密字段默认由主人完成，主人主动信任你时除外（回 USER_STEP，
  请用 foxpaw_need_human 举手）；删除/提交等会弹卡等主人批准，被拒就停。原始 CDP（含 Playwright）同样受这些规则约束。
- 等主人批准的命令最多等约 5 分钟（扩展 ≥1.33.2；更早约 1 分钟），请把工具调用超时设到 6 分钟以上；超时回 EXT_TIMEOUT / CONFIRM_TIMEOUT 时该命令已作废、绝不会事后补执行，可重新发起。
- 「只看」权限下读不到 Cookie / 本地存储等会话数据。
- 一个标签同一时刻只有一个写作者（租约锁）：写命令若回 TAB_LEASED，先只读观察或换个标签。
- 先调 foxpaw_whoami 看设备与占用，再动手。

## 6. 多台设备（device 参数）
主人可能有好几台浏览器（如「公司电脑」「家里 Mac」）。每个工具都可带 device（设备 id 如 d2，或设备名）：
- 你能用的设备只有一台时，不带 device 就用它。
- 能用的设备有多台时，第一次请带 device 指定；之后不带 device 的调用都落在你**上次指定**的那台。
- 上次指定的那台离线了，回 DEVICE_OFFLINE（附在线设备列表），**不会**自动改用另一台；请明确带 device。
- device 写的名字 / id 根本不存在时回 DEVICE_UNKNOWN（message 里列出可用设备 名字(id)）；存在但不在线才是 DEVICE_OFFLINE。
- 没指定过、又有多台可用时回 DEVICE_REQUIRED（附在线设备列表）；两台以上同时在线时回 DEVICE_AMBIGUOUS。
- foxpaw_whoami 列出你能用的设备和在线状态。
- 一台都用不了时：NO_DEVICE + reason——none_paired = 主人还没配对浏览器；offline = 你能用的浏览器都没开（附最近在线时间）；
  主人有浏览器但没给你授权任何一台时回 DEVICE_NONE_ALLOWED。每种都带 next（下一步怎么办），照做或转告主人即可。

## 7. 把事办成的做法
在主人的真实浏览器里干活：准比快重要，稳比花哨重要。下面是推荐做法，FoxPaw 工具的默认行为也按这些原则设计。
1. **先读后动**：动手前先看清页面（foxpaw_snapshot，或用 extract / query 只取需要的那一块），不要凭印象或网址猜页面结构。
2. **每步回读核对**：每一步都用回包核对结果——fill 看 actual / verified，click 看 navigated / noEffect / opened。结果不对先停下查原因，不要原样重复同一个动作。
3. **等页面稳定再判断**：导航看 load / readable；懒加载先 foxpaw_scroll {to:'bottom'} 或 snapshot autoScroll；等某段文字或某个元素用 foxpaw_wait_for，不要固定睡几秒。readable:true 就直接读，不要重试导航。
4. **结构化优先，看不懂再截图**：文字、链接、表格用 snapshot / extract / query；文字在图片里（imageHeavy:true）、或要看布局 / 图表时再 foxpaw_screenshot（能截元素或 clip 区域就别截全页）。长内容看 textHasMore / nextOffset 翻完，不要默认自己读全了。
5. **定位唯一**：优先 ref（来自最新快照），其次 role+name、label、text，CSS 选择器最后。回 AMBIGUOUS 就按候选挑准（nth），回 STALE_REF / STALE_DOCUMENT 就重新快照；不要点「看起来像」的元素。
6. **登录、验证、授权交还人**：登录过期、验证码 / 滑块、短信 / 扫码、授权，调 foxpaw_need_human 说清楚要主人做什么，等回执再继续。不要尝试绕过或破解验证。付款类按钮不用举手：点下去时会自动弹审批卡（标明金额），主人批准后才执行，被拒就停。
7. **卡住如实报，不编造**：拿不到的数据就说拿不到、为什么（错误码、页面状态）；不要补一个看起来合理的值。只完成了一部分，就说清楚完成了哪些、还差哪些。
8. **批量与流程复用优先**：同一页的多步读取放进 foxpaw_batch 一次往返；做过的事先 foxpaw_flow_list {site} 找现成流程回放、读站点经验；计数和全量清单用 foxpaw_extract，别逐个点开。做完把下次用得上的要点用 foxpaw_note_submit 留下。
9. **知道何时停**：目标达成就停；同一步换两种方法仍不行，就停下报告现状和建议的下一步；主人拒绝审批或让你停，立即停止，不绕路重试。只读调用的连接抖动中继已自动重试，不必自己循环重试。
10. **少打扰主人**：只操作 FoxPaw 组里的标签，用完关掉自己开的；不要频繁 foxpaw_activate_tab 抢前台。

## 8. 工具详细说明（tools/list 里每个工具只留一行要点，完整规则在这里）
所有工具都可带 task（你当前任务的简短标识，限定审批窗口与按任务的授权）和 device（多设备时必带）。

### foxpaw_whoami
Who you are, relay version, devices and their assigned tabs with current write-lease holders. Each device carries extVersion and extOutdated (older than the relay's download, extLatest) — an outdated extension may lack newer features; tell the owner to update. Relay ≥3.5: `trust` = your trust scope set by the owner (read-only: mode none | sites | all, sites, thisTask when the owner chose 「这次都放行」 for your current task, note = exactly what it covers). Relay 3.7.2 + extension ≥1.29: inside it fill / click / submit / delete / scripts (incl. raw CDP Runtime.*) need no card, and you may type values you hold (fill or raw CDP Input.*) into account / password / code / product stock-code (卡密) / image-captcha boxes (your own reading; sliders may be clicked / dragged; no captcha services — if you cannot pass it, foxpaw_need_human). Always the owner's: payment-class fields (card number / CVV / pay password), OAuth-authorize steps, local files. Pay steps (incl. subscribe / upgrade / purchase confirmations, extension ≥1.33.2) always get a card, trusted or not; once the owner approves, your click goes through. Untrusted: one approved card covers the same kind of action on that site for the rest of your task. Relay ≥3.6: devices[].logins = sites with a login the owner saved in FoxPaw (site + account, never a password; use them with foxpaw_login).

### foxpaw_request_elevation
Ask the browser owner for a temporary permission elevation on one device (max 2 hours). Returns a pending id; poll foxpaw_whoami to see the outcome.

### foxpaw_need_human
Raise your hand and WAIT for the browser owner: use when you are stuck on something only the human can do (login expired, captcha, SMS/QR code, second confirmation). Not for starting a recording: call foxpaw_recording_start yourself. The call blocks until the owner answers from the panel (up to 10 minutes): action 'continue' = they handled it, carry on; 'yield' = they want the tab themselves, stop operating that tab until they hand it back; 'stop' = abandon the task. On timeout you get NEED_HUMAN_TIMEOUT — treat it as a clear failure, do not retry in a loop.

### foxpaw_tabs
List the tabs you may use on the chosen device. `assigned` = tabs in the owner's FoxPaw group (operable). Only if the owner turned on "see all tabs" for you, `outside` lists the tabs outside the group: [{id, title, url, readonly:true}] — read-only (title + URL only; they can never be snapshotted or operated), and `all` = assigned + outside. Without that grant `outside` is absent. `events` carries tab_opened notices since your last call: a tab you hold the write lock on opened a new tab / popup ({tabId, openerTabId, url}); it joined the group and its write lock is yours when you were the only holder.

### foxpaw_snapshot
Snapshot of a tab: title, url, visible text excerpt, forms, and interactive elements, each with a ref plus role/tag/type/name. Extension ≥1.16: refs are stable per document (e12, or f5e12 inside an iframe; iframes and open shadow DOM included) and die on navigation (STALE_REF); older extensions use s3_12 refs valid until the next snapshot. `epoch` changes on navigation. Extension ≥1.18.1: open menus / dialogs / popovers (incl. portals) come first with `layer`; elements clickable without semantics (cursor:pointer, arco-link, table row actions) carry clickable:true and `row` (the row they act on); a card radio/checkbox whose input is hidden is listed as its label/card with proxyFor — click or fill that ref. 中继 3.8 + 扩展 ≥1.30：offset / limit 翻页（limit 默认 200、最大 1000；回 total、nextOffset，为 null 即读完；offset>0 的页不再带 text / forms）；子框架（含跨域 iframe / OOPIF，脚本进不去的经 CDP 只读，元素标 readOnly）在 frames[] 里标 url / crossOrigin；autoScroll:true 先滚到底（懒加载）再拍；frames:'main' 只拍顶层。要全量链接清单 / 计数用 foxpaw_extract。 中继 3.8.6 + 扩展 ≥1.32：正文不再 6000 字封顶——一次最多 textLimit 字（默认 20000），回 textTotal / textHasMore / textNextOffset，textOffset 翻正文（textOffset>0 只回正文）；其他扩展的悬浮挂件（文字与按钮）不计入；正文主要是图片时回 imageHeavy:true + hint（改用 foxpaw_screenshot）；后台标签停在人机 / 算力校验页时短暂切到前台等放行再切回（challenge:'off' 关闭），过不去回 USER_STEP。
- frames：all = 含全部子框架（含跨域 iframe，默认）；main = 只看顶层文档
- textOffset：start of the text page (chars; textNextOffset of the last reply)
- textLimit：chars of text per reply (default 20000, max 200000)
- challenge：auto (default): a bot-check page in a background tab is brought to the front of its window briefly; off: never

### foxpaw_navigate
Navigate a tab to a URL (http/https only; sites the owner blocked are refused). Extension ≥1.16 waits for load by default (waitUntil:"none" to return at once; timeout in ms). 扩展 ≥1.30：load 超时（load:'timeout'）时另回 state（readable 已渲染可读 | partial | blank）、readable、page{readyState, elements, links, textLength} 和 next——readable:true 就直接 foxpaw_snapshot / foxpaw_extract，不要重试导航。 扩展 ≥1.32：load:'error'（如 net::ERR_ABORTED）也回 state / readable / next；落地页是人机 / 算力校验页（WAF、JS 校验）时，后台标签会被短暂切到它所在窗口的前台（不抢窗口焦点）等它自动放行，放行后切回原来的前台标签（回包 challenge{kind, passed, foregroundMs}）；滑块 / 拼图 / 勾选类验证或超时（challengeWait 毫秒，默认 8000，最大 20000）回 USER_STEP——FoxPaw 从不替人过验证，请 foxpaw_need_human。challenge:'off' = 不做这一步。

### foxpaw_click
Click an element (real mouse via CDP; waits up to `timeout` ms, default 5 s, for it to be visible, enabled, stable and not covered — OBSCURED says what covers it; waits for the load when the click submits a form or follows a link). Locate by ONE of, in order of preference: ref (from the latest snapshot — fastest, exact), role + name (e.g. role:"button", name:"Sign in"), label, text, selector (CSS, last resort). Several matches = AMBIGUOUS with candidate refs; pick one with nth (0-based). exact:true = exact name match. Pass the snapshot's epoch to refuse clicking on a page that navigated meanwhile (STALE_DOCUMENT). Reply may carry navigated/load/epoch and opened:[{tabId,url}] (new tabs it opened). Delete/submit-like buttons may wait for the owner's approval (up to about 5 minutes, extension ≥1.33.2); pay buttons (incl. subscribe / upgrade / purchase confirmations) always get an approval card and go through once the owner approves; authorize is never done by agents (USER_STEP). role/name/label/text/selector/nth need extension ≥1.16 (older ones accept ref only). Extension ≥1.18.1 reports what the click did: effect:[navigation|dom|network|submit|state|focus…]; noEffect:true when nothing changed (do not assume success); fallback when it had to use the element's native action (requestSubmit for a swallowed submit button, details.open for a <summary>, input.click for a card radio/checkbox); retargeted when the click went through the element's own card or a same-name control on top; performed:false + pageAdvanced when the target stayed disabled because the page had already moved on. USER_STEP errors carry detail.needYou: the owner was notified — call foxpaw_need_human and wait for 「好了，继续」.

### foxpaw_fill
Fill form fields for real (dryRun defaults to false; dryRun:true only locates and reports). fields is an array; locate each field by ONE of: ref (from the latest snapshot — fastest, exact), role + name (accessible role and name, e.g. role:"textbox", name:"Email"), label (the visible label text), text (placeholder / nearby text), selector (CSS, last resort); exact:true = exact name match. kind optional (default: inferred from the element, incl. React/Ant selects and date pickers): text | select | combobox | checkbox | radio | date | contenteditable | file | slider. Reply: {ok, fields:[{ok, actual, error?}]} — check `actual`. Extension ≥1.18.1 also reads back the page framework's own value (React / Vue model) for text-like fields: verified:'model'|'dom', model; a field whose box shows the value but whose model did not take it is ok:false with the reason (no silent success). Password / OTP fields are USER_STEP (the owner types them) — except when the owner trusts you for this site (foxpaw_whoami trust): then any value you give (an account password you hold, a code from email, product stock codes 卡号 / 卡密 / 激活码, image-captcha characters you read — extension ≥1.29) is typed for you and read back as •••. Untrusted: a product stock-code box asks the owner once per task and site. Payment fields (card number, CVV, pay / trade password) are always the owner's. Extension ≥1.29: component dropdowns (Element UI / Element Plus incl. virtual lists, Ant, layui) are chosen by option text (kind inferred; not found → error lists the visible options); rich editors (wangEditor, Quill, ProseMirror, CKEditor, UEditor / KindEditor / TinyMCE iframes) take plain text, one paragraph per line; a field label not tied to its box (Element / Ant form items) is matched by the form item's label text; real typing that cannot get focus fails with FOCUS_LOST instead of typing into another box. CONFIRM_TIMEOUT = the owner did not answer the card in ~5 min (extension ≥1.33.2; ~50 s before): nothing ran, nothing else is blocked — foxpaw_need_human, then retry.
- fields.source：for password / code fields only: generated = a value you generated in this task; testsite = credentials for a site the owner marked as a test site. Needs the owner's grant; the owner's own saved passwords and payment cards are never fillable.
- fields.secretRef：name of a value the owner assigned to this task (the relay fills it in; you never see it)

### foxpaw_wait_for
Wait until a condition holds on a tab (default timeout 10 s, max 30 s), then return the fresh snapshot (use its refs; snapshot:false skips it). Give ONE of: text (visible text appears), textGone (text disappears), selector (CSS; state attached | detached | visible (default) | hidden), urlIncludes (substring), role + name, label (state:"hidden" = wait for it to disappear). Extension ≥1.16 waits inside the browser (text / textGone / selector / urlIncludes); role+name / label, and every condition on older extensions, are polled from snapshots by the relay (selector needs ≥1.16). Refs cannot be waited on. On timeout: WAIT_TIMEOUT.

### foxpaw_list_tasks
Cloud tasks assigned to you (or unassigned) plus your queued runs. MCP has no push channel: poll this to discover dispatched runs, then report with foxpaw_task_result.

### foxpaw_task_result
Report the terminal result of a run you executed (succeeded / failed / stopped). Only the agent that claimed the run may report it.

### foxpaw_flow_run
Replay a recorded flow (format foxpaw.flow/1: semantic steps — role+name / label / text locators, CSS only as fallback; waits, assertions, variables, collection steps extract / paginate / visit, new tabs and popups) in the owner's browser. Give the flow itself, or recordingId of a synced flow (foxpaw_flow_list). vars = values for the flow's non-secret variables; secret variables are refused (the owner types them). tabId = the start tab (t0). Every step goes through the same gate as your own clicks. Relay ≥3.4 + extension ≥1.21: the reply carries run_id (every run is recorded with per-step status and screenshots the owner can watch live) and a step that fails PAUSES the run instead of failing it (onFail:'fail' = old behaviour). Authorize steps and password / code / card fields are NEVER done by an agent: the run pauses there too (pay steps ask the owner on a card every time, extension ≥1.33.2). A paused reply has paused:true, status:'paused', pause {at, label, kind fail|user_step, code, reason}, actions [continue|retry|skip|abort] and next (what to do) — steer it with foxpaw_run {run_id, action}; ask the owner with foxpaw_need_human when a human must act. Done: ok:true, data (collected rows), timing. Older extensions: no live steps, failures end the run (at, code, message, shot), resume a USER_STEP with runId + from. Relay ≥3.7 + extension ≥1.28: recordingId may be an active flow or YOUR OWN draft (try your own recording at once; other agents' drafts → FLOW_NOT_ACCEPTED until the owner accepts). A waitInput step (e.g. an SMS / e-mail code) pauses with pause.kind 'input' and pause.input {var, prompt}: hand the value in with foxpaw_run {run_id, action:'input', value} (or give it up front in inputs:{var: value}); the field is then typed through the same gate as your own fill. A captcha / slider step (userStep reason captcha) always stops for the owner. data.outputs = values the flow outputs (copied fields); when a pause is on a flow an Agent recorded, flow_recorder names it.
- inputs：values for waitInput steps given up front ({var: value}, e.g. a code you already hold)
- runId：legacy resume: the extension run id from an older reply (with from)
- onFail：what a failing step does: pause and wait for continue / retry / skip / abort (default), or fail the run at once
- timeout：seconds to wait for the whole run (default 120, max 600)

### foxpaw_run
Check or steer a flow run you started (run_id from foxpaw_flow_run). No action = status: step N of M with its label, every step's status (ok / running / failed / paused / manual = done by a human / skipped / pending) and, when paused, where (pause.at, pause.label), why (pause.reason, pause.code, kind fail = the page did not cooperate, user_step = only the owner may do it) and the allowed actions. screenshot:true adds the latest step screenshot as an image. action on a PAUSED run: continue = the step was done by hand (by the owner, or after you asked with foxpaw_need_human) — go on from the next step; retry = run the same step again (the page recovered / you fixed what blocked it); skip = leave the step out and go on; abort = end the run (also stops a running one). continue / retry / skip block like foxpaw_flow_run until the run finishes or pauses again and reply in the same shape. The owner may already have handled the pause in the console or side panel (status then is running / succeeded / stopped) — always act on the status you get back. No run_id = your 10 most recent runs. Relay ≥3.7: a run paused on a waitInput step (pause.kind 'input', e.g. a verification code) takes action:'input' with value = the code — the run goes on from that step (the value is kept in memory only).
- value：for action 'input': the value the waiting step asked for
- timeout：seconds to wait after continue / retry / skip (default 120, max 600)

### foxpaw_open_tab
Open a new tab on the device (http/https or about:blank; sites the owner blocked are refused). The new tab joins this browser's FoxPaw group, so you can operate it. Write permission.

### foxpaw_close_tab
Close a tab in the FoxPaw group (tabs outside the group can never be closed). Write permission.

### foxpaw_activate_tab
Bring a FoxPaw-group tab to the front. Write permission.

### foxpaw_find_tabs
Ask the owner to add an already-open tab to the FoxPaw group: query is matched against open tabs' titles/URLs and the owner gets a confirmation card (about 1 minute). On a refusal nothing about outside tabs is revealed.

### foxpaw_cdp
Raw CDP command on a FoxPaw-group tab ("raw mode"). Needs the owner's per-agent "raw CDP" grant, else RAW_CDP_NOT_GRANTED. Still passes the extension's gate (pay/authorize steps and payment fields refused, sensitive writes need approval). Inside the owner's trust (extension ≥1.29) Runtime.* scripts need no card and Input.insertText / dispatchKeyEvent may type your own password / code / 卡密 / captcha characters; the reply carries typedInto {name, tag} = the box the keys went to (check it: focus moves). Without trust one approved card covers that kind of action on that site for the task. Playwright connectOverCDP (foxpaw_cdp_endpoint) runs scripts for nearly every action — use it inside trust, or expect one card per site first. Prefer the semantic tools.

### foxpaw_cdp_endpoint
Playwright connectOverCDP endpoint for one device (raw mode, needs the per-agent "raw CDP" grant). Returns {path}: GET <relay><path>/json/version, WebSocket at <path>/ws; expires after 30 idle minutes.

### foxpaw_task_accept
Claim a queued run (from foxpaw_list_tasks) before executing it, so it is not expired as unclaimed.

### foxpaw_task_progress
Report progress of a run you claimed (keeps it alive; steps_done / steps_total / note).

### foxpaw_recording_start
Start recording a flow in the owner's browser ("teach FoxPaw"): to have what YOU are about to do recorded, call this yourself — never ask the owner to click 录制 in the side panel for you (that is the owner's own recording of their own steps: it starts on the tab they are looking at and its name is typed when they stop and save, not at start). tabId = the start tab, name = the flow name (or give it at stop). Extension ≥1.33.2: the owner's active tab, when it is not the start tab (usually the page where they chat with you), is left out — nothing typed there is recorded; operate it with a tool to include it. from now on your own foxpaw_click / foxpaw_fill / foxpaw_navigate … on the group's tabs are recorded as semantic steps, and the owner sees a live step count in the panel. goal = one sentence shown to the owner. One recording per browser (REC_LOCKED otherwise). When the page needs a login the recording PAUSES and the owner is asked to log in — the login is never recorded; poll foxpaw_whoami or wait, then continue. Finish with foxpaw_recording_stop: the result becomes a DRAFT flow (source: Agent 录制, recorded under YOUR name) — you can replay your own draft at once with foxpaw_flow_run recordingId (relay ≥3.7); other agents and scheduled tasks can use it only after the owner accepts it. Check foxpaw_flow_list {site} first — maybe a flow already exists. Needs extension ≥1.19.
- tabId：start tab (in the FoxPaw group)

### foxpaw_recording_stop
Stop your recording on the device and turn it into a draft flow (source: Agent 录制). Returns draftId — replay it yourself right away (relay ≥3.7). Secret values (passwords, codes, cards) are never in it; the owner reviews it in the panel / console (收下 / 驳回 / 重录). replaces = id of a flow this recording is a new version of (your older draft of it is retired at once; an active one when the owner accepts).
- name：flow name, e.g. 企查查 · 导出工商报告
- replaces：id of the flow this is a new version of

### foxpaw_flow_draft_submit
Submit what you just did (a run trajectory you distilled) as a DRAFT flow (format foxpaw.flow/1; source: Agent 代跑). Drafts never carry credential plaintext: secret / personal fields must be variables without values (DRAFT_HAS_SECRET otherwise). You cannot change flows already in effect — submit a new version as a draft with replaces = the old flow id (relay ≥3.7: your own older draft is retired at once; an active flow when the owner accepts, and its tasks move to the new version). You can replay your own drafts at once; only the owner accepts or rejects them for everyone else.
- replaces：id of the flow this draft is a new version of
- goal：one sentence: what the flow achieves
- note：what the run did / caveats, shown to the owner

### foxpaw_set_profile
Set your own name and/or avatar shown to the owner (avatar: base64 png/jpg/webp ≤256 KB, or "default").

### foxpaw_flow_list
Look for an existing flow BEFORE exploring a site yourself: flows you may replay (the owner's flows in effect + your own drafts; id, name, goal, steps, site, non-secret vars, inputs = values asked for while it runs, recorder, mine; lastIssue = the latest failed / paused run of the flow, shown to every agent that may run it — fix it and submit a new version with foxpaw_flow_draft_submit replaces) — run one with foxpaw_flow_run recordingId — and the status of YOUR drafts (草稿 / 已生效 / 已驳回, with the owner's note). Relay ≥3.7: filter with site (domain or URL; sub-domains match) and/or q (words in name / goal). Relay ≥3.8.7: with site / q the reply also carries notes = the site notes (站点经验) in effect + your own drafts (id, site, title, text, topic, by, status, mine) — read them before you act; without a filter noteSites lists which sites have notes. Leave what you learn with foxpaw_note_submit.
- site：e.g. qcc.com or https://www.qcc.com/...
- q：words in the flow name / goal

### foxpaw_note_submit
Leave a site note (站点经验) for the owner's other agents: what you learned about a site that is not a replayable step — the way in (entry URL / menu path), traps, what to wait for, how login / bot checks behave. Plain text, ≤2000 chars; never passwords, tokens, codes or card numbers (such text is filtered out and the reply says so). You see your own note at once in foxpaw_flow_list {site}; the owner's other agents see it after the owner accepts it in the console (流程 › 经验). replaces = the id of a note this one updates (a note on the same site with the same title counts as a new version too); when the owner accepts the new version the old one is retired.
- site：the site the note is about: domain or URL (e.g. qcc.com); stored under the main domain, sub-domains match
- title：one line, ≤80 chars (default: the first line of text)
- text：the note, ≤2000 chars: entry, traps, waits, login / verification — what the next agent needs
- topic：entry 入口 | pitfall 坑 | wait 等待 | login 登录 / 校验 | other
- replaces：id of the note this one updates (from foxpaw_flow_list notes[].id)

### foxpaw_login
Sign in on a tab with a login the owner saved in FoxPaw (relay ≥3.6 + extension ≥1.26). You never see the password: the extension finds the page's account + password boxes, types the saved values in the owner's browser (read back as •••) and, unless submit:false, presses the sign-in button. site = the site whose login to use (main domain, e.g. github.com; sub-domains match; default = the tab's own site) — it is only ever typed on that site. user = which account when several are saved for the site. Which sites have a login: foxpaw_whoami devices[].logins (site + account), or call this tool without tabId. If the owner trusts you for that site (foxpaw_whoami trust: 全部网站 / this site / 「这次都放行」) it runs at once; otherwise the owner gets one card 「允许你用 TA 的 site 登录」 (up to about 5 minutes). A username-first page (no password box yet) gets the account only (step:'username') — call again on the password page. Never on payment pages or payment password boxes (USER_STEP). Errors: NO_SAVED_LOGIN (ask the owner to add it, or foxpaw_need_human), AMBIGUOUS_LOGIN (pass user), LOGIN_SITE_MISMATCH (navigate to the site first), NO_LOGIN_FORM (open the sign-in page), EXT_UPGRADE_REQUIRED (the extension on that device is older than 1.26). userRef / passwordRef (snapshot refs) override the boxes FoxPaw picks.
- submit：press the sign-in button after filling (default true)

### foxpaw_login_save
Save a login YOU just created for the owner (e.g. after signing up an account on their behalf) into FoxPaw on their browser (relay ≥3.6 + extension ≥1.26): site (address or domain) + user (account name) + password, optional note. It is stored encrypted in the owner's extension only, never kept by the relay; the reply shows the password as ••• and nothing can read it back to you later — use it with foxpaw_login. Inside the owner's trust for that site it is saved at once; otherwise (and always when it would replace a login the owner saved themselves) the owner approves one card.

### foxpaw_extract
抽取页面内全部匹配（只读，扩展 ≥1.30）：按 CSS 选择器（默认 a[href]）和 / 或 URL 正则 match（textMatch 匹配文字），返回去重清单 items[{href, text, n?=重复次数, frame?}] + count（去重后）+ matched（去重前）。默认含所有 frame（跨域 iframe 也算，frames[] 标每个 frame 的 url / crossOrigin / 条数），不受快照元素上限影响，计数类任务用它。attr = 取哪个属性（默认 href/src）；visibleOnly 只要可见的；dedupe url（默认）| text | none；groupByFrame 按 frame 分组；limit 默认 2000，最大 10000。懒加载列表先 foxpaw_scroll 到底。
- match：URL 正则（不区分大小写），如 /product/\d+
- frames：all = 含全部子框架（含跨域 iframe，默认）；main = 只看顶层文档

### foxpaw_scroll
滚动页面（只读，扩展 ≥1.30）。to："bottom"（默认；反复滚到底，直到高度 / 链接数不再增长或到上限，适合懒加载、无限滚动）| "top" | 数字 N（滚 N 屏，负数往上）；或给 ref / selector 滚到该元素。每轮滚完在页内等一个静默窗口（无节点增删、无资源完成，默认 400 ms），一长高就立刻再滚，第一轮无新增即停；页面本身不可滚直接返回（stoppedBy notScrollable，扩展 ≥1.30.1）。扩展 ≥1.31.0：页内静默后若该标签还有在途请求（接口 / 脚本 / 文档，不含图片、长连接与超 10 秒的请求），先等请求回来再判一次，慢接口且无加载动画的懒加载也能读全；返回 net{observed, waits, waitedMs}。返回：rounds、stoppedBy（stable | notScrollable | maxRounds | timeout）、waitedMs、height / heightBefore、links / linksBefore、grew、atBottom、container（页面或内部滚动容器）。timeout 毫秒（默认 20000，最大 55000），maxRounds 默认 40，settleMs 静默窗口毫秒（默认 400，200–5000；扩展 <1.31 时，站点接口慢、懒加载不带加载动画请调大）。
- to：bottom | top | 屏数（数字）

### foxpaw_query
只读 DOM 查询（扩展 ≥1.30，免审批，只看权限可用；不执行任何脚本）：selector + get = text（默认）| href | attr（配 attr 名）| value（密码等秘密框回 •••）| count | exists | visible | checked。返回 count（命中总数）+ values（最多 limit，默认 200，最大 5000）。中继 3.8.6 + 扩展 ≥1.32：data: URI（如内嵌图片 src）默认只回开头 + 总长度，其他属性值默认截到 maxLen（2000）字，要原文传 full:true。fields = 每个命中元素里取多个值 {列名: {selector?(相对), get, attr?}}，适合读表格行；withRef:true 每项带 ref 可直接点。frames 默认 main（all = 含子框架）。要改页面请用 click / fill；写类脚本仍走 foxpaw_cdp 的门。
- full：true = return attribute values and data: URIs in full (default: data: URIs give head + length, others cut at maxLen)
- frames：all = 含全部子框架（含跨域 iframe，默认）；main = 只看顶层文档

### foxpaw_screenshot
截图（只读，扩展 ≥1.30），直接返回图片（MCP image）。默认当前视口；fullPage:true 全页（超过 12000 px 只截前段，cropped:true）；给 ref / selector / role+name 截该元素（仅顶层文档）。format jpeg（默认）| png，quality 默认 70，maxWidth 默认 1280；图过大自动降质量 / 缩小（约 1 MB 以内）。中继 3.8.6 + 扩展 ≥1.32：clip {x, y, width, height}（页面坐标 CSS px）截指定区域；后台标签截不到画面时自动把它短暂切到它所在窗口的前台截完再切回（回包 foreground），不必先 activate；delivery:"url" 另回 imageUrl（10 分钟内有效的下载地址，给只显示文字的客户端用）。
- clip：a region {x, y, width, height} in page CSS px
- delivery：image (default) = MCP image content; url = imageUrl only (a 10-minute download link); both

### foxpaw_batch
一次调用顺序执行多步、一次返回各步结果（中继 ≥3.8）。steps = [{do, ...该工具的参数}]，do ∈ navigate | wait_for | click | fill | scroll | snapshot | extract | query | screenshot（最多 20 步）。顶层 tabId / device 作为各步默认值。某步失败即停：ok:false + failedAt（第几步，从 1 起）+ error + 之前各步结果（该步 continueOnError:true 则记下错误继续）。每一步照旧走权限 / 审批 / 信任 / 写锁，不会因为在 batch 里就放宽；截图作为图片附在回包后面。例：[{do:'navigate',url},{do:'scroll'},{do:'extract',match:'/product/'},{do:'screenshot'}]。
