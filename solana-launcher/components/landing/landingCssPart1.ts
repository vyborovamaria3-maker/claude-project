// Auto-generated from approved POTAPoff landing CSS.
export const LANDING_CSS_PART_1 = String.raw`
:root{
  --bg:#05070b;--bg2:#080c13;--panel:#0b1018;--panel2:#0f151f;
  --line:rgba(255,255,255,.075);--line2:rgba(255,255,255,.13);
  --text:#f7f9fc;--muted:#8c98aa;--green:#7cff6b;--green2:#a4ff78;
  --green-soft:rgba(124,255,107,.09);--purple:#8b5cf6;--blue:#38bdf8;
  --red:#ff7188;--max:1240px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;background:var(--bg)}
body{margin:0;background:
radial-gradient(circle at 10% 12%,rgba(139,92,246,.12),transparent 28rem),
radial-gradient(circle at 87% 32%,rgba(124,255,107,.09),transparent 32rem),
linear-gradient(180deg,#040609,#05070b 45%,#060912 100%);
color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-x:hidden}
body:before{content:"";position:fixed;inset:0;z-index:-2;pointer-events:none;background-image:
linear-gradient(rgba(255,255,255,.022) 1px,transparent 1px),
linear-gradient(90deg,rgba(255,255,255,.022) 1px,transparent 1px);
background-size:56px 56px;mask-image:linear-gradient(to bottom,black,black 65%,transparent)}
body.modal-open{overflow:hidden}
a{text-decoration:none;color:inherit}
button,input{font:inherit}
button{cursor:pointer}
.wrap{width:min(var(--max),calc(100% - 32px));margin:auto}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{height:72px;position:sticky;top:0;z-index:20;border-bottom:1px solid var(--line);background:rgba(5,7,11,.76);backdrop-filter:blur(18px) saturate(135%)}
.header{height:100%;display:flex;align-items:center;justify-content:space-between;gap:24px}
.brand{display:flex;align-items:center;gap:11px}
.logo{width:40px;height:40px;border:1px solid var(--line2);border-radius:13px;position:relative;background:rgba(255,255,255,.025);box-shadow:0 0 30px -18px var(--green)}
.logo:before{content:"";position:absolute;left:10px;right:10px;top:19px;height:2px;background:var(--green);transform:rotate(-34deg);border-radius:5px}
.logo:after{content:"";position:absolute;width:6px;height:6px;border-radius:50%;background:#fff;left:17px;top:17px;box-shadow:0 0 10px #fff}
.brand strong{display:block;font-size:14px;font-weight:900}.brand small{display:block;color:#566276;font-size:8px;letter-spacing:.18em;text-transform:uppercase}
nav{display:flex;align-items:center;gap:26px;color:#8e99a9;font-size:12px}
nav a:hover{color:#fff}
.header-actions{display:flex;align-items:center;gap:8px}
.btn{height:42px;padding:0 15px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.03);color:#fff;font-weight:780}
.btn:hover{border-color:var(--line2)}
.btn.primary{background:linear-gradient(135deg,var(--green),#a0ff76);color:#061006;border-color:rgba(124,255,107,.35);box-shadow:0 18px 50px -28px rgba(124,255,107,.75)}
.btn.large{height:49px;padding:0 19px;border-radius:14px}
.lang{height:42px;padding:0 11px;display:grid;place-items:center;border:1px solid var(--line);border-radius:12px;color:#788598;font-size:10px}

.hero{min-height:760px;display:grid;grid-template-columns:.83fr 1.17fr;gap:45px;align-items:center;padding:62px 0 82px}
.eyebrow{display:inline-flex;align-items:center;gap:7px;padding:7px 11px;border:1px solid rgba(124,255,107,.24);border-radius:999px;background:var(--green-soft);color:var(--green);font-size:9px;font-weight:850;letter-spacing:.13em;text-transform:uppercase}
.eyebrow i{width:6px;height:6px;background:var(--green);border-radius:50%;box-shadow:0 0 9px var(--green)}
h1{margin:23px 0 0;font-size:clamp(54px,6.4vw,86px);line-height:.91;letter-spacing:-.063em;font-weight:920}
h1 span{display:block;background:linear-gradient(95deg,#fff 5%,#b29aff 43%,#86ff70 92%);color:transparent;background-clip:text;-webkit-background-clip:text}
.hero-copy{max-width:510px;margin:22px 0 0;color:#97a3b5;font-size:16px;line-height:1.72}
.hero-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:27px}
.hero-points{display:flex;flex-wrap:wrap;gap:13px 20px;margin-top:27px;color:#6f7d90;font-size:10px}
.hero-points span{display:flex;align-items:center;gap:6px}.hero-points i{width:6px;height:6px;border-radius:50%;background:var(--green)}
.market-shell{position:relative}
.market-shell:before{content:"";position:absolute;inset:8% 8% 5%;z-index:-1;border-radius:50%;background:radial-gradient(circle,rgba(124,255,107,.14),rgba(139,92,246,.08) 45%,transparent 70%);filter:blur(36px)}
.terminal{border:1px solid rgba(255,255,255,.11);border-radius:24px;padding:7px;background:linear-gradient(145deg,rgba(255,255,255,.06),rgba(255,255,255,.015));box-shadow:0 45px 110px -50px #000}
.terminal-inner{overflow:hidden;border:1px solid rgba(255,255,255,.055);border-radius:18px;background:#080c12}
.terminal-top{height:44px;padding:0 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);color:#657286;font-size:8px;letter-spacing:.1em}
.dots{display:flex;gap:5px}.dots i{width:7px;height:7px;border-radius:50%;background:#394352}.dots i:nth-child(1){background:#ff6b64}.dots i:nth-child(2){background:#e7bb52}.dots i:nth-child(3){background:#62ca74}
.live{color:var(--green);font-weight:900}.market{padding:19px}
.token-line{display:flex;align-items:center;justify-content:space-between;gap:16px}
.token{display:flex;align-items:center;gap:10px}.token-logo{width:38px;height:38px;display:grid;place-items:center;border:1px solid var(--line2);border-radius:12px;background:linear-gradient(145deg,rgba(124,255,107,.12),rgba(139,92,246,.12));font-weight:900}
.token strong{display:block;font-size:12px}.token small{display:block;color:#596579;font-size:8px;margin-top:2px}
.market-source{padding:6px 9px;border:1px solid var(--line);border-radius:999px;color:#596579;font-size:7px}
.price-row{display:flex;align-items:end;justify-content:space-between;gap:16px;margin-top:18px}
.market-label{color:#566276;font-size:8px;letter-spacing:.14em}.price{font-size:38px;line-height:1;font-weight:920;letter-spacing:-.04em;margin-top:6px}
.change{padding:8px 10px;border-radius:10px;background:var(--green-soft);border:1px solid rgba(124,255,107,.18);color:var(--green);font-size:11px;font-weight:850}
.ranges{display:flex;align-items:center;gap:6px;margin-top:16px;flex-wrap:wrap}
.ranges button{height:29px;min-width:42px;padding:0 9px;border:1px solid var(--line);border-radius:8px;background:rgba(255,255,255,.02);color:#687588;font-size:8px;font-weight:850}
.ranges button.active{color:var(--green);border-color:rgba(124,255,107,.25);background:var(--green-soft)}
.chart{height:315px;position:relative;overflow:hidden;margin-top:11px;border:1px solid rgba(255,255,255,.055);border-radius:15px;background:linear-gradient(180deg,rgba(124,255,107,.05),transparent 45%),#080c12}
.chart:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);background-size:100% 25%,20% 100%}
.chart svg{position:absolute;inset:0;width:100%;height:100%}.area{fill:url(#fill)}.glow{fill:none;stroke:var(--green);stroke-width:8;opacity:.12}.line{fill:none;stroke:var(--green);stroke-width:2.3;vector-effect:non-scaling-stroke}.last-dot{position:absolute;width:10px;height:10px;border-radius:50%;background:var(--green);border:2px solid #071008;box-shadow:0 0 14px var(--green)}
.market-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:8px}.market-metrics div{padding:9px;border:1px solid var(--line);border-radius:9px;background:rgba(255,255,255,.018)}.market-metrics small{display:block;color:#505c6e;font-size:6px;letter-spacing:.1em}.market-metrics strong{display:block;margin-top:4px;font-size:9px}
.float-card{position:absolute;padding:10px 12px;border:1px solid var(--line2);border-radius:12px;background:rgba(8,12,18,.92);box-shadow:0 18px 45px rgba(0,0,0,.35)}.float-card small{display:block;color:#546173;font-size:7px}.float-card strong{display:block;margin-top:3px;font-size:14px}.fc1{left:-23px;bottom:68px}.fc2{right:-22px;top:106px}.fc2 strong{color:var(--green)}

.strip{border-block:1px solid var(--line);background:rgba(255,255,255,.014)}
.strip-grid{display:grid;grid-template-columns:repeat(3,1fr)}.strip-item{display:flex;align-items:center;gap:13px;padding:21px 0}.strip-item:not(:last-child){border-right:1px solid var(--line)}.strip-item:not(:first-child){padding-left:25px}.strip-icon{width:40px;height:40px;display:grid;place-items:center;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.025);color:var(--green);font-size:17px}.strip-item strong{display:block;font-size:12px}.strip-item small{display:block;color:#6e7a8c;font-size:10px;margin-top:3px}

.section{padding:100px 0}.section-head{max-width:780px}.kicker{color:var(--green);font-size:9px;font-weight:850;letter-spacing:.16em;text-transform:uppercase}.section h2{margin:14px 0 0;font-size:clamp(34px,4.5vw,58px);line-height:1.02;letter-spacing:-.045em}.section-head p{max-width:680px;margin:15px 0 0;color:#8996a8;font-size:15px;line-height:1.7}
.product-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-top:38px}.product-card{min-height:275px;padding:24px;border:1px solid var(--line);border-radius:22px;background:linear-gradient(145deg,rgba(255,255,255,.038),rgba(255,255,255,.012));position:relative;overflow:hidden}.product-card:after{content:"";position:absolute;width:220px;height:220px;border-radius:50%;right:-100px;top:-100px;background:rgba(124,255,107,.07);filter:blur(45px)}.product-top{display:flex;align-items:center;justify-content:space-between}.product-icon{width:46px;height:46px;display:grid;place-items:center;border:1px solid var(--line2);border-radius:14px;background:rgba(255,255,255,.035);color:var(--green);font-weight:900}.num{color:#4d596a;font-size:9px}.product-card h3{font-size:20px;margin:38px 0 0}.product-card p{max-width:500px;color:#7d899b;font-size:13px;line-height:1.65}.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:18px}.chips span{padding:6px 8px;border:1px solid var(--line);border-radius:8px;color:#59667a;font-size:7px}

.workspace{background:linear-gradient(180deg,rgba(255,255,255,.012),rgba(139,92,246,.025));border-block:1px solid var(--line)}
.workspace-layout{display:grid;grid-template-columns:.8fr 1.2fr;gap:44px;align-items:center}.workspace-copy p{color:#8996a8;font-size:15px;line-height:1.7}.workspace-list{display:grid;gap:9px;margin-top:24px}.workspace-list div{display:flex;align-items:center;gap:10px;color:#8793a4;font-size:12px}.workspace-list i{width:7px;height:7px;border-radius:50%;background:var(--green)}
.app-shell{border:1px solid var(--line2);border-radius:22px;padding:7px;background:rgba(255,255,255,.03);box-shadow:0 35px 100px -55px #000}.app{overflow:hidden;border:1px solid var(--line);border-radius:16px;background:#080c12}.app-top{height:42px;display:flex;align-items:center;justify-content:space-between;padding:0 13px;border-bottom:1px solid var(--line);font-size:8px;color:#5c6879}.app-main{display:grid;grid-template-columns:150px 1fr;min-height:390px}.sidebar{border-right:1px solid var(--line);padding:12px}.side-logo{height:34px;border:1px solid var(--line);border-radius:10px;margin-bottom:13px;background:rgba(255,255,255,.025)}.side-item{height:31px;display:flex;align-items:center;padding:0 9px;margin-bottom:5px;border-radius:8px;color:#5f6b7d;font-size:8px}.side-item.active{color:#c9ffd0;background:var(--green-soft);border:1px solid rgba(124,255,107,.13)}.dashboard{padding:14px}.dash-title{display:flex;align-items:center;justify-content:space-between}.dash-title strong{font-size:12px}.dash-title span{font-size:7px;color:var(--green)}.dash-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:13px}.dash-card{height:76px;padding:9px;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.02)}.dash-card small{color:#556173;font-size:6px}.dash-card strong{display:block;margin-top:9px;font-size:15px}.dash-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:8px;margin-top:8px}.dash-panel{min-height:205px;border:1px solid var(--line);border-radius:11px;background:rgba(255,255,255,.018);padding:10px}.mini-chart{height:125px;margin-top:9px;border-radius:8px;background:linear-gradient(180deg,rgba(124,255,107,.06),transparent);position:relative;overflow:hidden}.mini-chart:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);background-size:100% 33%,25% 100%}.mini-bars{display:flex;align-items:end;gap:4px;height:125px;padding:10px}.mini-bars i{flex:1;background:linear-gradient(var(--green),rgba(124,255,107,.15));border-radius:3px 3px 0 0}.feed{display:grid;gap:7px;margin-top:9px}.feed div{height:34px;border:1px solid var(--line);border-radius:8px;background:rgba(255,255,255,.018)}

.cta-wrap{padding:95px 0 110px}.cta{padding:42px;border:1px solid rgba(124,255,107,.22);border-radius:25px;background:linear-gradient(135deg,rgba(124,255,107,.09),rgba(56,189,248,.035) 45%,rgba(139,92,246,.09));display:flex;align-items:center;justify-content:space-between;gap:30px}.cta h2{font-size:clamp(30px,4vw,48px);margin:0;max-width:750px;letter-spacing:-.045em;line-height:1.03}.cta p{color:#8390a2;font-size:13px;max-width:700px;line-height:1.6}
footer{border-top:1px solid var(--line);padding:30px 0 38px}.footer{display:flex;align-items:center;justify-content:space-between;gap:20px;color:#556173;font-size:10px}

`;