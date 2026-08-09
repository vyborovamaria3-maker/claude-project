// Generated from POTAPoff-landing-unified-font.html.
// Keep the markup and CSS together so the production page matches the approved standalone preview.

export const LANDING_CSS = String.raw`
    :root {
      --bg: #05070b;
      --bg-soft: #080b12;
      --card: #0d121c;
      --card-2: #111927;
      --border: rgba(255,255,255,.085);
      --border-strong: rgba(124,255,107,.30);
      --text: #f7fbff;
      --muted: #8e9bad;
      --green: #7cff6b;
      --green-dark: #071008;
      --green-soft: rgba(124,255,107,.105);
      --blue: #38bdf8;
      --purple: #8b5cf6;
      --amber: #f8d66d;
      --max: 1380px;
      --radius: 28px;
      --tracking-tight: -0.025em;
    }

    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; overflow-x: clip; }
    body {
      margin: 0;
      min-width: 320px;
      color: var(--text);
      background:
        radial-gradient(circle at 10% 4%, rgba(124,255,107,.08), transparent 30rem),
        radial-gradient(circle at 92% 38%, rgba(139,92,246,.10), transparent 34rem),
        var(--bg);
      font-family: var(--font-inter), "Manrope", "Segoe UI Variable", "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      font-optical-sizing: auto;
      font-kerning: normal;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      line-height: 1.5;
      overflow-x: clip;
    }

    h1, h2, h3, h4 {
      letter-spacing: var(--tracking-tight);
      text-wrap: balance;
    }

    button, .btn, .login-submit {
      letter-spacing: -0.01em;
    }

    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: .46;
      background-image:
        linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px);
      background-size: 52px 52px;
      mask-image: linear-gradient(to bottom, black, transparent 88%);
      z-index: -3;
    }

    a { color: inherit; text-decoration: none; }
    button, input, textarea, select { font: inherit; }
    h1, h2, h3, h4, h5, h6, p, span, strong, small, label, a, button, input, textarea, select { font-family: inherit; }
    svg { display: block; }

    .icon { width: 1.1em; height: 1.1em; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .container { width: min(var(--max), calc(100% - 40px)); margin-inline: auto; }
    .mono { font-family: inherit; font-variant-numeric: tabular-nums; }
    .green { color: var(--green); }

    .orb {
      position: fixed;
      width: 34rem;
      height: 34rem;
      border-radius: 50%;
      filter: blur(90px);
      opacity: .12;
      pointer-events: none;
      z-index: -2;
    }
    .orb.one { left: -18rem; top: 5rem; background: var(--green); }
    .orb.two { right: -20rem; top: 32rem; background: var(--purple); }

    header {
      position: sticky;
      top: 0;
      z-index: 20;
      border-bottom: 1px solid rgba(255,255,255,.055);
      background: rgba(5,7,11,.78);
      backdrop-filter: blur(24px);
    }
    .header-inner { height: 76px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-mark {
      position: relative;
      width: 42px;
      height: 42px;
      border-radius: 14px;
      display: grid;
      place-items: center;
      border: 1px solid var(--border-strong);
      background: var(--green-soft);
      box-shadow: 0 0 35px -14px rgba(124,255,107,.7);
      color: var(--green);
    }
    .brand-mark::after { content:""; position:absolute; width:6px; height:6px; border-radius:50%; background:#fff; box-shadow:0 0 12px #fff; }
    .brand-title { font-weight: 950; letter-spacing: .18em; font-size: 14px; }
    .brand-sub { margin-top: 1px; font-size: 9px; text-transform: uppercase; letter-spacing: .24em; color: rgba(255,255,255,.34); font-weight: 700; }
    nav { display: flex; align-items: center; gap: 32px; }
    nav a { font-size: 14px; color: rgba(255,255,255,.55); transition: .25s ease; }
    nav a:hover { color: #fff; }
    .header-actions { display: flex; align-items: center; gap: 10px; }
    .lang { padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border); background: rgba(255,255,255,.035); color: rgba(255,255,255,.64); font-size: 12px; }

    .button {
      min-height: 48px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      border-radius: 16px;
      padding: 0 20px;
      border: 1px solid var(--border-strong);
      background: var(--green);
      color: var(--green-dark);
      font-size: 14px;
      font-weight: 900;
      box-shadow: 0 20px 55px -22px rgba(124,255,107,.75);
      transition: transform .25s ease, filter .25s ease, border-color .25s ease;
      cursor: pointer;
    }
    .button:hover { transform: translateY(-2px); filter: brightness(1.08); }
    .button.secondary { background: rgba(255,255,255,.035); color: #fff; border-color: rgba(255,255,255,.105); box-shadow: none; font-weight: 750; }
    .button.secondary:hover { border-color: rgba(255,255,255,.22); }
    .button.small { min-height: 44px; padding-inline: 16px; border-radius: 12px; background: rgba(255,255,255,.04); border-color: rgba(255,255,255,.10); color: #fff; box-shadow: none; }
    .button.small:hover { background: var(--green-soft); border-color: var(--border-strong); }

    .menu-toggle { display: none; width: 42px; height: 42px; color: #fff; border-radius: 12px; border: 1px solid var(--border); background: rgba(255,255,255,.04); place-items: center; }
    .mobile-menu { display: none; border-top: 1px solid rgba(255,255,255,.06); padding: 12px 0 18px; }
    .mobile-menu.open { display: grid; gap: 4px; }
    .mobile-menu a { padding: 10px 12px; color: rgba(255,255,255,.70); }

    .hero {
      min-height: calc(100vh - 76px);
      display: grid;
      grid-template-columns: .93fr 1.07fr;
      align-items: center;
      gap: 58px;
      padding-block: 80px;
    }
    .eyebrow {
      width: fit-content;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      border: 1px solid var(--border-strong);
      background: var(--green-soft);
      color: var(--green);
      padding: 8px 14px;
      font-size: 11px;
      font-weight: 850;
      text-transform: uppercase;
      letter-spacing: .18em;
    }
    .hero h1 {
      margin: 28px 0 0;
      max-width: 780px;
      font-size: clamp(3.4rem, 7vw, 6.7rem);
      letter-spacing: -.067em;
      line-height: .92;
      font-weight: 950;
    }
    .gradient-text {
      display: block;
      margin-top: 5px;
      color: transparent;
      background: linear-gradient(110deg, #fff 5%, var(--green) 42%, var(--blue) 72%, #a74bfa);
      background-clip: text;
      -webkit-background-clip: text;
    }
    .hero-copy { max-width: 700px; margin: 28px 0 0; color: rgba(255,255,255,.55); font-size: 18px; line-height: 1.75; }
    .hero-actions { display: flex; gap: 12px; margin-top: 34px; flex-wrap: wrap; }
    .trust { margin-top: 34px; display: flex; flex-wrap: wrap; gap: 14px 24px; color: rgba(255,255,255,.45); font-size: 12px; font-weight: 600; }
    .trust span { display: inline-flex; align-items: center; gap: 8px; }
    .check-dot { width: 21px; height: 21px; border-radi²È="25•˜ôˆÑ•Éµ¥¹…°ˆ¼øğ½ÍÙœûBƒBÃBÇBûFBãBäƒBÿFBûFB×FFğ½‘¥Øøñ ÈûBsB×B÷F3F#BÔƒBËBëBïBÃBÓBûBè¸ƒBGBûBïF3F#BÔƒBûFBûBßB÷BÃB÷B÷F/FƒBÓB×BçFFBËBãBä¸ğ½ ÈøñÀûBBïBÃFFBûFBóBÀƒBÿBûFFFBûB×B÷BÀƒBËBûBëFFBÌƒFFFGFƒBÏBïBÃBËB÷F/FƒBËBûBÿFBûFBûBÈèƒFFBøƒBÿFBûBãFFBûBÓBãF°ƒFFBûBãFƒBïBàƒBÓB×BçFFBËBûBËBÃFF0ƒBàƒBëBÃBèƒBËF/BÿBûBïB÷BãFF0ƒBûBÿB×FBÃFBãF8¸ğ½Àøğ½‘¥Øøñ‘¥Ø±…ÍÌô‰İ½É­™±½ÜµÉ¥ˆøñ…ÉÑ¥±”±…ÍÌô‰ÍÑ•ÀÉ•Ù•…°ˆøñ‘¥Ø±…ÍÌô‰ÍÑ•Àµ¥½¸ˆøñÍÙœ±…ÍÌô‰¥½¸ˆİ¥‘Ñ ôˆÈäˆ¡•¥¡ĞôˆÈäˆøñÕÍ”¡É•˜ôˆÍ•…É ˆ¼øğ½ÍÙœøñÍÁ…¸±…ÍÌô‰ÍÑ•Àµ¹Õµ‰•Èµ½¹¼ˆøÀÄğ½ÍÁ…¸øğ½‘¥Øøñ ÌûBwBÃBçBÓBàƒFBãBÏB÷BÃBìğ½ ÌøñÀûB{FFBïB×BÛBãBËBÃBçFBÔƒB÷BûBËF/BÔƒBßBÃBÿFFBëBà°ƒBÓBËBãBÛB×B÷BãBÔƒFF/B÷BëBÀ°ƒBÃBëFBãBËB÷BûFFF0ƒBëBûF#B×BïF3BëBûBÈƒBàƒBëBûB÷FB×BëFFƒFBûBëB×B÷BÀƒBÈƒBûBÓB÷BûBğƒBÿFB×BÓFFBÃBËBïB×B÷BãBà¸ğ½Àøğ½…ÉÑ¥±”øñ…ÉÑ¥±”±…ÍÌô‰ÍÑ•ÀÉ•Ù•…°ˆøñ‘¥Ø±…ÍÌô‰ÍÑ•Àµ¥½¸ˆøñÍÙœ±…ÍÌô‰¥½¸ˆİ¥‘Ñ ôˆÈäˆ¡•¥¡ĞôˆÈäˆøñÕÍ”¡É•˜ôˆÑ…É•Ğˆ¼øğ½ÍÙœøñÍÁ…¸±…ÍÌô‰ÍÑ•Àµ¹Õµ‰•Èµ½¹¼ˆøÀÈğ½ÍÁ…¸øğ½‘¥Øøñ ÌûBFBûBËB×FF0ƒBÏBãBÿBûFB×BßFğ½ ÌøñÀûBcFBÿBûBïF3BßFBçFBÔƒBÃB÷BÃBïBãBÜƒBÓB×FBÛBÃFB×BïB×Bä°ƒFBÃBßFBÃBÇBûFFBãBëBÀ°ƒBïBãBëBËBãBÓB÷BûFFBàƒBàƒFBÓB×BïBûBè°ƒFFBûBÇF,ƒFBóB×B÷F3F#BãFF0ƒFBïB×BÿF/BÔƒBßBûB÷F,ƒBÓBøƒBËBïBûBÛB×B÷BãF<ƒFFB×BÓFFBÈ¸ğ½Àøğ½…ÉÑ¥±”øñ…ÉÑ¥±”±…ÍÌô‰ÍÑ•ÀÉ•Ù•…°ˆøñ‘¥Ø±…ÍÌô‰ÍÑ•Àµ¥½¸ˆøñÍÙœ±…ÍÌô‰¥½¸ˆİ¥‘Ñ ôˆÈäˆ¡•¥¡ĞôˆÈäˆøñÕÍ”¡É•˜ôˆ‰½±Ğˆ¼øğ½ÍÙœøñÍÁ…¸±…ÍÌô‰ÍÑ•Àµ¹Õµ‰•Èµ½¹¼ˆøÀÌğ½ÍÁ…¸øğ½‘¥Øøñ ÌûB_BÃBÿFFFBàƒBãBïBàƒBãFBÿBûBïB÷Bàğ½ ÌøñÀûBB×FB×FBûBÓBãFBÔƒBãBÜƒBÃB÷BÃBïBãFBãBëBàƒBÈƒBßBÃBÿFFBè°‰Õ¹‘±”ƒBãBïBàƒFBûFBÏBûBËF/BäƒFFB×B÷BÃFBãBäƒBÇB×BÜƒBÿBûFB×FBàƒFBûBÇFBÃB÷B÷BûBÏBøƒBëBûB÷FB×BëFFBÀ¸ğ½Àøğ½…ÉÑ¥±”øğ½‘¥Øøğ½‘¥Øøğ½Í•Ñ¥½¸ø((€€€€ñÍ•Ñ¥½¸±…ÍÌô‰½¹Ñ…¥¹•È‰±½¬É¥Í¬µÉ¥ˆ¥ô‰É¥Í¬ˆøñ‘¥Ø±…ÍÌô‰Í•Ñ¥½¸µ¡•…‘¥¹œÉ•Ù•…°ˆøñ‘¥Ø±…ÍÌô‰Í•Ñ¥½¸µ­¥­•Èµ½¹¼ˆøñÍÙœ±…ÍÌô‰¥½¸ˆøñÕÍ”¡É•˜ôˆÍ¡¥•±ˆ¼øğ½ÍÙœûBƒBãFBè·BëBûB÷FFBûBïF0ƒBÈƒBûFB÷BûBËBÔğ½‘¥Øøñ ÈûBGBûBïF3F#BÔƒBÿFBûBßFBÃFB÷BûFFBà°ƒBÇB×BÜƒBïBûBÛB÷BûBäƒFBËB×FB×B÷B÷BûFFBà¸ğ½ ÈøñÀûBkFBãBÿFBûBûBÿB×FBÃFBãBàƒFBËF?BßBÃB÷F,ƒFƒBËF/FBûBëBãBğƒFBãFBëBûBğ¸ƒBBïBÃFFBûFBóBÀƒBÿBûBóBûBÏBÃB×FƒBËBãBÓB×FF0ƒFBÃBëFF,ƒBàƒFFBÃFFFƒBãFBÿBûBïB÷B×B÷BãF<°ƒFFBûBÇF,ƒFB×F#B×B÷BãF<ƒBûBÿBãFBÃBïBãFF0ƒB÷BÔƒFBûBïF3BëBøƒB÷BÀƒFBÃBçBü¸ğ½Àøğ½‘¥Øøñ‘¥Ø±…ÍÌô‰É¥Í¬µ±¥ÍĞÉ•Ù•…°ˆøñ‘¥Ø±…ÍÌô‰É¥Í¬µ¥Ñ•´ˆøñÍÁ…¸±…ÍÌô‰É¥Í¬µ¹Õ´µ½¹¼ˆøÀÄğ½ÍÁ…¸øñÀù•Ø´ƒBàİ…±±•Ğµ™½É•¹Í¥ÌƒBÿBûBóBûBÏBÃF;FƒBËF/F?BËBïF?FF0ƒFBËF?BßBà°ƒBëBûB÷FB×B÷FFBÃFBãF8ƒBàƒBÿBûBÓBûBßFBãFB×BïF3B÷F/BÔƒBÿBûBËB×BÓB×B÷FB×FBëBãBÔƒBÿBÃFFB×FB÷F,¸ğ½Àøğ½‘¥Øøñ‘¥Ø±…ÍÌô‰É¥Í¬µ¥Ñ•´ˆøñÍÁ…¸±…ÍÌô‰É¥Í¬µ¹Õ´µ½¹¼ˆøÀÈğ½ÍÁ…¸øñÀûB‡BãBóFBïF?FBãF<ƒBàƒF7FBÃBüƒBÿFBûBËB×FBëBàƒBÿBûBëBÃBßF/BËBÃF;FƒBëFBãFBãFB÷F/BÔƒBÿBÃFBÃBóB×FFF,ƒBßBÃBÿFFBëBÀƒBà‰Õ¹‘±”ƒBÓBøƒBûFBÿFBÃBËBëBà¸ğ½Àøğ½‘¥Øøñ‘¥Ø±…ÍÌô‰É¥Í¬µ¥Ñ•´ˆøñÍÁ…¸±…ÍÌô‰É¥Í¬µ¹Õ´µ½¹¼ˆøÀÌğ½ÍÁ…¸øñÀûB[BãBËBûBäƒFFBÃFFF°ƒBïBûBÏBàƒBàƒBÃB÷BÃBïBãFBãBëBÀƒBÿBûBóBûBÏBÃF;FƒBÿBûB÷F?FF0°ƒFFBøƒBÿFBûBãBßBûF#BïBøƒBÿBûFBïBÔƒBãFBÿBûBïB÷B×B÷BãF<¸ğ½Àøğ½‘¥Øøñ‘¥Ø±…ÍÌô‰‘¥Í±…¥µ•ÈˆøñÍÙœ±…ÍÌô‰¥½¸ˆøñÕÍ”¡É•˜ôˆ…±•ÉĞˆ¼øğ½ÍÙœøñÍÁ…¸ùA=QA½™˜ƒŠPƒBãB÷FB×FFB×BçFƒBÃB÷BÃBïBãFBãBëBàƒBàƒBãFBÿBûBïB÷B×B÷BãF<°ƒBÀƒB÷BÔƒFBãB÷BÃB÷FBûBËBÃF<ƒFB×BëBûBóB×B÷BÓBÃFBãF<¸=¸µ¡…¥¸ƒBÃBëFBãBËF,ƒBóBûBÏFFƒBÇF/FFFBøƒFB×FF?FF0ƒFFBûBãBóBûFFF0ìƒFBÃBóBûFFBûF?FB×BïF3B÷BøƒBÿFBûBËB×FF?BçFBÔƒBëBûB÷FFBÃBëFF,°ƒBëBûF#B×BïF3BëBàƒBàƒBÿBÃFBÃBóB×FFF,ƒFFBÃB÷BßBÃBëFBãBä¸ğ½ÍÁ…¸øğ½‘¥Øøğ½‘¥Øøğ½Í•Ñ¥½¸ø((€€€€ñÍ•Ñ¥½¸±…ÍÌô‰½¹Ñ…¥¹•Èˆ¥ô‰Ñ„ˆÍÑå±”ô‰Á…‘‘¥¹œµ‰½ÑÑ½´èÄÈÁÁàˆøñ‘¥Ø±…ÍÌô‰Ñ„É•Ù•…°ˆøñ‘¥Øøñ‘¥Ø±…ÍÌô‰Ñ„µ­¥­•Èµ½¹¼ˆùId€¼MP€¼M=19ğ½‘¥Øøñ ÈûB—BËBÃFBãFƒBÿB×FB×BëBïF;FBÃFF0ƒBãB÷FFFFBóB×B÷FF,¸ƒBwBÃFB÷BãFBÔƒBÓB×BçFFBËBûBËBÃFF0ƒBÇF/FFFB×BÔ¸ğ½ ÈøñÀûB{BÓBãBôƒBãB÷FB×FFB×BçFƒBÓBïF<ƒBßBÃBÿFFBëBÀ°ƒBÃB÷BÃBïBãFBãBëBàƒBàƒBãFBÿBûBïB÷B×B÷BãF<ƒŠPƒFƒBËBÃBÛB÷F/BğƒBëBûB÷FB×BëFFBûBğƒBÿFF?BóBøƒBÿB×FB×BĞƒBÏBïBÃBßBÃBóBà¸ğ½Àøğ½‘¥Øøñ„±…ÍÌô‰‰ÕÑÑ½¸ˆ¡É•˜ôˆ±½¥¸ˆ‘…Ñ„µ½Á•¸µ±½¥¸ûB{FBëFF/FF0ƒBÿBïBÃFFBûFBóF€ñÍÙœ±…ÍÌô‰¥½¸ˆøñÕÍ”¡É•˜ôˆ…ÉÉ½Üˆ¼øğ½ÍÙœøğ½„øğ½‘¥Øøğ½Í•Ñ¥½¸ø(€€ğ½µ…¥¸ø((€€ñ™½½Ñ•Èøñ‘¥Ø±…ÍÌô‰½¹Ñ…¥¹•È™½½Ñ•Èµ¥¹¹•Èˆøñ‘¥Ø±…ÍÌô‰™½½Ñ•Èµ‰É…¹ˆøñÍÁ…¸±…ÍÌô‰‰É…¹µµ…É¬ˆøñÍÙœ±…ÍÌô‰¥½¸ˆİ¥‘Ñ ôˆÈÈˆ¡•¥¡ĞôˆÈÈˆøñÕÍ”¡É•˜ôˆ½É‰¥Ğˆ¼øğ½ÍÙœøğ½ÍÁ…¸øñ‘¥Øøñ‘¥Ø±…ÍÌô‰™½½Ñ•ÈµÑ¥Ñ±”ˆùA=QA½™˜ğ½‘¥Øøñ‘¥ØûBƒBÃBÇBûFB×BÔƒBÿFBûFFFBÃB÷FFBËBøƒBÓBïF<ƒBßBÃBÿFFBëBÀ°ƒBÃB÷BÃBïBãFBãBëBàƒBàƒBãFBÿBûBïB÷B×B÷BãF<ƒBÈM½±…¹„¸ğ½‘¥Øøğ½‘¥Øøğ½‘¥Øøñ‘¥Ø±…ÍÌô‰™½½Ñ•Èµ±¥¹­ÌˆøñÍÁ…¸û
¤€ñÍÁ…¸¥ô‰å•…Èˆøğ½ÍÁ…¸øA=QA½™˜ğ½ÍÁ…¸øñ„¡É•˜ôˆÑ½ÀˆûBwBÃBËB×FFƒŠDğ½„øğ½‘¥Øøğ½‘¥Øøğ½™½½Ñ•Èø((((€€ñÍ•Ñ¥½¸±…ÍÌô‰±½¥¸µµ½‘…°ˆ¥ô‰±½¥¸ˆÉ½±”ô‰‘¥…±½œˆ…É¥„µµ½‘…°ô‰ÑÉÕ”ˆ…É¥„µ±…‰•±±•‘‰äô‰±½¥¹Q¥Ñ±”ˆ…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆø(€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰±½¥¸µ‰…­‘É½ÀˆÑåÁ”ô‰‰ÕÑÑ½¸ˆ‘…Ñ„µ±½Í”µ±½¥¸Ñ…‰¥¹‘•àôˆ´Äˆ…É¥„µ±…‰•°ô‹B_BÃBëFF/FF0ƒFBûFBóFƒBËFBûBÓBÀˆøğ½‰ÕÑÑ½¸ø(€€€€ñ‘¥Ø±…ÍÌô‰±½¥¸µ…ÉˆÉ½±”ô‰‘½Õµ•¹Ğˆø(€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰±½¥¸µ±½Í”ˆÑåÁ”ô‰‰ÕÑÑ½¸ˆ‘…Ñ„µ±½Í”µ±½¥¸…É¥„µ±…‰•°ô‹B_BÃBëFF/FF0ˆø(€€€€€€€€ñÍÙœ±…ÍÌô‰¥½¸ˆøñÕÍ”¡É•˜ôˆ±½Í”ˆ¼øğ½ÍÙœø(€€€€€€ğ½‰ÕÑÑ½¸ø(€€€€€€ñ‘¥Ø±…ÍÌô‰±½¥¸µÁ…¹•°ˆø(€€€€€€€€ñ‘¥Ø±…ÍÌô‰±½¥¸µ¡•…ˆø(€€€€€€€€€€ñ‘¥Øø(€€€€€€€€€€€€ñ‘¥Ø±…ÍÌô‰±½¥¸µ‰…‘”ˆøñÍÙœ±…ÍÌô‰¥½¸ˆøñÕÍ”¡É•˜ôˆ±½¬ˆ¼øğ½ÍÙœøƒBGB×BßBûBÿBÃFB÷F/BäƒBËFBûBĞğ½‘¥Øø(€€€€€€€€€€€€ñ È±…ÍÌô‰±½¥¸µÑ¥Ñ±”ˆ¥ô‰±½¥¹Q¥Ñ±”ˆûBoBûBÏBãBôƒBàƒBÿBÃFBûBïF0ğ½ Èø(€€€€€€€€€€€€ñÀ±…ÍÌô‰±½¥¸µÍÕ‰Ñ¥Ñ±”ˆûBKBËB×BÓBãFBÔƒFFFGFB÷F/BÔƒBÓBÃB÷B÷F/BÔ°ƒFFBûBÇF,ƒBÿFBûBÓBûBïBÛBãFF0ƒFBÃBÇBûFFƒBÈƒBÿBÃB÷B×BïBàA=QA½™˜¸ğ½Àø(€€€€€€€€€€ğ½‘¥Øø(€€€€€€€€€€ñ‘¥Ø±…ÍÌô‰±½¥¸µÍ¡¥•±ˆ…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆøñÍÙœ±…ÍÌô‰¥½¸ˆİ¥‘Ñ ôˆÈÌˆ¡•¥¡ĞôˆÈÌˆøñÕÍ”¡É•˜ôˆÍ¡¥•±ˆ¼øğ½ÍÙœøğ½‘¥Øø(€€€€€€€€ğ½‘¥Øø((€€€€€€€€ñ‘¥Ø±…ÍÌô‰±½¥¸µ¡¥¹ĞˆûBKBËB×BÓBãFBÔƒBïBûBÏBãBôƒBà€ÌÈ·FBãBóBËBûBïF3B÷F/BäƒBÿBÃFBûBïF0°ƒBëBûFBûFF/BÔƒBËF,ƒBÿBûBïFFBãBïBàƒBãBïBàƒBßBÃBÓBÃBïBàƒBÈQ•±•É…´5¥¹¤ÁÀ¸ğ½‘¥Øø((€€€€€€€€ñ™½É´±…ÍÌô‰±½¥¸µ™½É´ˆ¥ô‰Á±…Ñ™½Éµ1½¥¹½É´ˆ¹½Ù…±¥‘…Ñ”ø(€€€€€€€€€€ñ±…‰•°±…ÍÌô‰™¥•±ˆø(€€€€€€€€€€€€ñÍÁ…¸±…ÍÌô‰™¥•±µ±…‰•°ˆûBoBûBÏBãBôğ½ÍÁ…¸ø(€€€€€€€€€€€€ñÍÁ…¸±…ÍÌô‰¥¹ÁÕĞµÍ¡•±°ˆø(€€€€€€€€€€€€€€ñÍÙœ±…ÍÌô‰¥½¸¥¹ÁÕĞµ¥½¸ˆøñÕÍ”¡É•˜ôˆÕÍ•Èˆ¼øğ½ÍÙœø(€€€€€€€€€€€€€€ñ¥¹ÁÕĞ±…ÍÌô‰±½¥¸µ¥¹ÁÕĞˆ¥ô‰±½¥¹%¹ÁÕĞˆ¹…µ”ô‰±½¥¸ˆÑåÁ”ô‰Ñ•áĞˆ¥¹ÁÕÑµ½‘”ô‰Ñ•áĞˆ…ÕÑ½½µÁ±•Ñ”ô‰ÕÍ•É¹…µ”ˆÁ±…•¡½±‘•Èô‹BKBËB×BÓBãFBÔƒBïBûBÏBãBôˆµ¥¹±•¹Ñ ôˆĞˆµ…á±•¹Ñ ôˆÌÈˆÉ•ÅÕ¥É•€¼ø(€€€€€€€€€€€€ğ½ÍÁ…¸ø(€€€€€€€€€€ğ½±…‰•°ø((€€€€€€€€€€ñ±…‰•°±…ÍÌô‰™¥•±ˆø(€€€€€€€€€€€€ñÍÁ…¸±…ÍÌô‰™¥•±µ±…‰•°ˆûBBÃFBûBïF0ğ½ÍÁ…¸ø(€€€€€€€€€€€€ñÍÁ…¸±…ÍÌô‰¥¹ÁÕĞµÍ¡•±°ˆø(€€€€€€€€€€€€€€ñÍÙœ±…ÍÌô‰¥½¸¥¹ÁÕĞµ¥½¸ˆøñÕÍ”¡É•˜ôˆ±½¬ˆ¼øğ½ÍÙœø(€€€€€€€€€€€€€€ñ¥¹ÁÕĞ±…ÍÌô‰±½¥¸µ¥¹ÁÕĞÁ…ÍÍİ½Éµ¥¹ÁÕĞˆ¥ô‰Á…ÍÍİ½É‘%¹ÁÕĞˆ¹…µ”ô‰Á…ÍÍİ½ÉˆÑåÁ”ô‰Á…ÍÍİ½Éˆ…ÕÑ½½µÁ±•Ñ”ô‰ÕÉÉ•¹ĞµÁ…ÍÍİ½ÉˆÁ±…•¡½±‘•Èô‹BKBËB×BÓBãFBÔƒBÿBÃFBûBïF0ƒBãBÜ€ÌÈƒFBãBóBËBûBïBûBÈˆµ¥¹±•¹Ñ ôˆÌÈˆµ…á±•¹Ñ ôˆÌÈˆÉ•ÅÕ¥É•€¼ø(€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰Á…ÍÍİ½ÉµÑ½±”ˆ¥ô‰Á…ÍÍİ½É‘Q½±”ˆÑåÁ”ô‰‰ÕÑÑ½¸ˆ…É¥„µ±…‰•°ô‹BBûBëBÃBßBÃFF0ƒBÿBÃFBûBïF0ˆ…É¥„µÁÉ•ÍÍ•ô‰™…±Í”ˆøñÍÙœ±…ÍÌô‰¥½¸ˆøñÕÍ”¥ô‰Á…ÍÍİ½É‘å•UÍ”ˆ¡É•˜ôˆ•å”ˆ¼øğ½ÍÙœøğ½‰ÕÑÑ½¸ø(€€€€€€€€€€€€ğ½ÍÁ…¸ø(€€€€€€€€€€ğ½±…‰•°ø((€€€€€€€€€€ñ‘¥Ø±…ÍÌô‰±½¥¸µ…±•ÉĞˆ¥ô‰±½¥¹±•ÉĞˆÉ½±”ô‰…±•ÉĞˆ…É¥„µ±¥Ù”ô‰…ÍÍ•ÉÑ¥Ù”ˆøğ½‘¥Øø((€€€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰±½¥¸µÍÕ‰µ¥Ğˆ¥ô‰±½¥¹MÕ‰µ¥ĞˆÑåÁ”ô‰ÍÕ‰µ¥Ğˆø(€€€€€€€€€€€€ñÍÙœ±…ÍÌô‰¥½¸ˆøñÕÍ”¡É•˜ôˆ±½¬ˆ¼øğ½ÍÙœø(€€€€€€€€€€€€ñÍÁ…¸ûBKBûBçFBàƒBÈƒBÿBÃB÷B×BïF0ğ½ÍÁ…¸ø(€€€€€€€€€€ğ½‰ÕÑÑ½¸ø(€€€€€€€€ğ½™½É´ø((€€€€€€€€ñ‘¥Ø±…ÍÌô‰±½¥¸µ™½½Ğˆø(€€€€€€€€€€ñ„¡É•˜ô‰¡ÑÑÁÌè¼½Ğ¹µ”½M½™ĞÜÜİ‰½ĞˆÑ…É•Ğô‰}‰±…¹¬ˆÉ•°ô‰¹½½Á•¹•È¹½É•™•ÉÉ•ÈˆûBBûBïFFBãFF0ƒBÓBûFFFBüƒŠHğ½„ø(€€€€€€€€ğ½‘¥Øø(€€€€€€ğ½‘¥Øø(€€€€ğ½‘¥Øø(€€ğ½Í•Ñ¥½¸ø(((€€ì(