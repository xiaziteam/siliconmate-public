// 硅侣统一 PAC — 「锦上添花」策略 v2（2026-09-19 重构）
//
// 产品铁律（麦克 2026-09-19）：
//   1. 绝不破坏任何网络环境 — 默认直连，只有明确需要梯子的域名才走代理
//   2. 路由要智能、普适 — 国内域名/国内 IP 自动直连；被墙域名走东京梯子
//   3. 未知域名 = 直连（宁可少翻一个站，不能把用户流量送出国触发风控）
//
// 事故背景：v1 兜底策略是"未知域名全走 SOCKS5(东京)"，导致闲鱼/银行等
// 一切不在白名单的国内网站被送出国（登录页默认日本+账号风控异常）。
// 若发生在客户环境 = 严重事故。此版本反转兜底方向，永久修复。
//
// 分流顺序（快→慢）：
//   1. 本机/内网/国内后缀 → DIRECT（零 DNS 开销）
//   2. 被墙域名清单 → SOCKS5 127.0.0.1:1080（梯子）
//   3. 主流国内站清单 → DIRECT（零 DNS 开销）
//   4. dnsResolve → 中国 IP 段（APNIC 主干）→ DIRECT
//   5. 兜底 → DIRECT
//
// 维护：加被墙站 → gfw 数组；加国内站 → cn 数组。文件改动即时生效
//（com.shrimp.pac-server 为静态 http.server）。

function FindProxyForURL(url, host) {
  // ── 1. 本机/内网/结构化国内后缀，直连 ──────────────────────
  if (isPlainHostName(host)) return "DIRECT";
  if (shExpMatch(host, "*.local") || shExpMatch(host, "*.lan") ||
      shExpMatch(host, "*.cn") || shExpMatch(host, "*.com.cn") ||
      shExpMatch(host, "*.net.cn") || shExpMatch(host, "*.org.cn") ||
      shExpMatch(host, "*.gov.cn") || shExpMatch(host, "*.edu.cn") ||
      shExpMatch(host, "*.中国")) return "DIRECT";

  // ── 2. 被墙域名（明确需要梯子）→ 东京 SOCKS5 ───────────────
  var gfw = [
    // Google 系
    ".google.com", ".googleapis.com", ".gstatic.com", ".googlevideo.com",
    ".ggpht.com", ".googleusercontent.com", ".google.com.hk", ".googlemail.com",
    ".youtube.com", ".ytimg.com", ".youtu.be", ".googleusercontent.cn",
    // AI 系
    ".openai.com", ".chatgpt.com", ".oaistatic.com", ".oaiusercontent.com",
    ".anthropic.com", ".claude.ai", ".perplexity.ai",
    // 社交系
    ".twitter.com", ".x.com", ".twimg.com", ".t.co",
    ".facebook.com", ".fbcdn.net", ".fbsbx.com", ".messenger.com",
    ".instagram.com", ".cdninstagram.com",
    ".telegram.org", ".t.me",
    ".discord.com", ".discordapp.com", ".discordapp.net", ".discord.gg",
    ".reddit.com", ".redd.it", ".redditmedia.com",
    ".medium.com", ".quora.com",
    // 知识/参考系
    ".wikipedia.org", ".wikimedia.org", ".wiktionary.org", ".wikiquote.org",
    // 流媒体系
    ".netflix.com", ".nflxvideo.net", ".nflximg.net", ".nflxext.com",
    ".disneyplus.com", ".spotify.com", ".scdn.co", ".twitch.tv", ".ttvnw.net",
    // 开发者系
    ".docker.io", ".gcr.io", ".huggingface.co", ".v2ex.com", ".steamcommunity.com",
    // 其他
    ".pixiv.net", ".pximg.net", ".line.me", ".naver.com", ".blogspot.com",
    ".blogger.com", ".appspot.com", ".workers.dev", ".notion.so", ".notion.site"
  ];
  for (var i = 0; i < gfw.length; i++) {
    var g = gfw[i];
    if (host === g.slice(1) || shExpMatch(host, "*" + g)) return "SOCKS5 127.0.0.1:1080; DIRECT";
  }

  // ── 3. 主流国内站（跳过 DNS，快速直连）─────────────────────
  var cn = [
    ".taobao.com", ".tmall.com", ".alipay.com", ".alibaba.com", ".alicdn.com",
    ".aliyun.com", ".goofish.com", ".tb.cn", ".1688.com",
    ".jd.com", ".360buyimg.com", ".jkcsjd.com",
    ".qq.com", ".wechat.com", ".qpic.cn", ".qlogo.cn", ".gtimg.cn",
    ".baidu.com", ".bdstatic.com", ".bdimg.com", ".bcebos.com",
    ".bilibili.com", ".hdslb.com", ".acgvideo.com",
    ".zhihu.com", ".zhimg.com",
    ".douyin.com", ".douyinpic.com", ".douyincdn.com", ".douyinstatic.com",
    ".kuaishou.com", ".ksapisrv.com", ".ks-cdn.com", ".yxixy.com",
    ".xiaohongshu.com", ".xhscdn.com",
    ".sina.com.cn", ".weibo.com", ".wbimg.cn", ".miaopai.com",
    ".163.com", ".netease.com", ".126.com", ".ydstatic.com", ".youdao.com",
    ".meituan.com", ".dianping.com", ".meituan.net", ".ele.me",
    ".ctrip.com", ".qunar.com", ".trip.com",
    ".mi.com", ".xiaomi.com", ".miui.com", ".vmall.com",
    ".huawei.com", ".hicloud.com", ".vmall.com",
    ".pinduoduo.com", ".yangkeduo.com", ".pddpic.com",
    ".suning.com", ".gome.com.cn", ".vip.com",
    ".iqiyi.com", ".youku.com", ".mgtv.com", ".letv.com",
    ".ifeng.com", ".sohu.com", ".sogou.com", ".360.cn", ".haosou.com",
    ".csdn.net", ".cnblogs.com", ".jianshu.com", ".oschina.net", ".gitee.com",
    ".coolapk.com", ".sspaq.com",
    // 华为云直连：海外出口访问国内云 CDN 易超时（2026-09-18 AI Shell 白屏修复教训）
    ".huaweicloud.com", ".myhuaweicloud.com", ".hc-cdn.com", ".hc-cdn.cn"
  ];
  for (var j = 0; j < cn.length; j++) {
    var c = cn[j];
    if (host === c.slice(1) || shExpMatch(host, "*" + c)) return "DIRECT";
  }

  // ── 4. 中国 IP 段（APNIC 主干 /8 近似，误判方向安全=直连）──
  var ip = "";
  try { ip = dnsResolve(host); } catch (e) { return "DIRECT"; }
  if (!ip) return "DIRECT";
  var cnNets = [
    "1.", "14.", "27.", "36.", "39.", "42.", "47.", "58.", "59.", "60.",
    "61.", "101.", "106.", "110.", "111.", "112.", "113.", "114.", "115.",
    "116.", "117.", "118.", "119.", "120.", "121.", "122.", "123.", "124.",
    "125.", "139.", "180.", "182.", "183.", "202.", "203.", "210.", "211.",
    "218.", "219.", "220.", "221.", "222.", "223."
  ];
  for (var k = 0; k < cnNets.length; k++) {
    if (ip.indexOf(cnNets[k]) === 0) return "DIRECT";
  }
  // 常见私有段兜底
  if (isInNet(ip, "10.0.0.0", "255.0.0.0") || isInNet(ip, "172.16.0.0", "255.240.0.0") ||
      isInNet(ip, "192.168.0.0", "255.255.0.0") || isInNet(ip, "127.0.0.0", "255.0.0.0")) return "DIRECT";

  // ── 5. 兜底：直连（绝不默认走梯子）────────────────────────
  return "DIRECT";
}

// ============================================================================
// 部署说明（虾群内部）：
// - 目标位置: /Users/apple/.pac/proxy.pac（由 com.shrimp.pac-server 静态服务 :18085）
// - 硅侣桌面版 login 时设系统 PAC 指向 http://127.0.0.1:18085/proxy.pac（tunnel.rs）
// - 域名白名单维护对齐: 服务端 tunnel_configs.route_domains（Android 下发同一哲学）
// - 未来迭代方向: 从服务端动态拉取 route_domains 生成 PAC，三端统一
// ============================================================================
