/* landing.js — 落地頁 / 專案介紹頁 共用多語引擎
 *
 * 三種語言：中文（繁體，澳門習用）、English、Português。
 * 文案全部放在 I18N 裡；頁面載入時依 localStorage → 瀏覽器語言 → 中文 決定預設，
 * 並提供下拉切換。落地頁與專案介紹頁共用同一份字典，各頁只取自己用到的鍵。
 */
(function () {
  "use strict";

  var I18N = {
    "zh-Hant": {
      brand: "澳門車位",
      nav: { features: "功能", faq: "常見問題", about: "專案介紹" },
      cta: "查看即時車位",
      hero: {
        eyebrow: "澳門公共停車場 · 實時資訊",
        titlePre: "出門前，先看澳門",
        titleHi: "哪裡還有車位",
        lead: "即時查詢全澳公共停車場的剩餘空位，每 30 分鐘自動更新。數據來自澳門交通事務局官方資訊。",
        cta: "查看即時車位",
        about: "了解這個專案",
        trust: ["每 30 分鐘自動更新", "數據來源：澳門交通事務局 DSAT", "手機直接打開就用"]
      },
      features: {
        kicker: "功能亮點",
        title: "一個網頁，停車大小事都搞定",
        sub: "不用安裝、不用註冊，打開就能用。",
        items: [
          { t: "即時空位", d: "一眼看到每個停車場還剩多少個位，不用到現場才發現滿座。" },
          { t: "使用率一目了然", d: "用顏色和百分比告訴你停車場有多滿，紅色代表快滿了。" },
          { t: "避開最擠時段", d: "看看一週裡什麼時候最難停車，挑人少的時間出門。" },
          { t: "地圖一眼找", d: "在地图上直接看到附近停車場的擁擠程度，規劃最順路的一站。" }
        ]
      },
      stats: {
        title: "覆蓋全澳，隨時可查",
        items: [
          { n: "90+", l: "公共停車場" },
          { n: "30 分鐘", l: "自動更新一次" },
          { n: "2 種", l: "車位：私家車 · 電單車" }
        ]
      },
      use: {
        kicker: "使用情境",
        title: "什麼時候用得上？",
        sub: "只要你在澳門開車或騎車，它都能幫上忙。",
        items: [
          { t: "上班通勤", d: "早上趕著上班，先確認公司附近還有沒有位，省下繞圈找車位的時間。" },
          { t: "週末出遊", d: "假日去景點或商圈，避開人擠人的熱門停車場。" },
          { t: "接送家人", d: "去醫院、學校或機場接送，提前看好空位不慌張。" }
        ]
      },
      how: {
        kicker: "使用方式",
        title: "三步，輕鬆查車位",
        sub: "",
        steps: [
          { t: "選車種", d: "先選你是開私家車還是電單車。" },
          { t: "搜尋地點", d: "輸入停車場名稱或地區，快速找到想去的場。" },
          { t: "看即時空位", d: "點進去就能看到剩餘車位、使用率和最不擠的時段。" }
        ]
      },
      faq: {
        kicker: "常見問題",
        title: "大家常問的",
        items: [
          { q: "這個網站的數據準確嗎？", a: "數據來自澳門交通事務局（DSAT）的官方即時資訊，我們每 30 分鐘自動更新一次。實際情況可能因車輛進出而略有變化，僅供參考。" },
          { q: "收費嗎？要註冊嗎？", a: "完全免費，不需要註冊或下載，用手機瀏覽器打開就能用。" },
          { q: "覆蓋哪些停車場？", a: "覆蓋澳門各區的公共停車場，包含澳門半島與離島。部分私人停車場可能不在名單內。" },
          { q: "這是官方網站嗎？", a: "不是。這是一個由個人維護的獨立專案，單純把官方公開數據整理得更易讀、更好用。" },
          { q: "資料多久更新一次？", a: "每 30 分鐘自動更新一次，你看到的數字都盡量保持最新。" }
        ]
      },
      preview: [
        { n: "市中心", free: 18, cap: 120 },
        { n: "景點區", free: 4, cap: 90 },
        { n: "住宅區", free: 52, cap: 200 },
        { n: "商場", free: 9, cap: 150 }
      ],
      foot: {
        tag: "把澳門交通事務局的即時停車數據，整理成每個人都能一眼看懂的網頁。",
        col1: "網站",
        links: [
          { t: "即時車位", h: "index.html" },
          { t: "專案介紹", h: "about.html" }
        ],
        disclaim: "本網站非澳門特別行政區政府官方網站。數據來源：澳門交通事務局（DSAT）。",
        copy: "© 2026 澳門車位 · 資料每 30 分鐘自動更新"
      },
      about: {
        kicker: "專案介紹",
        title: "關於「澳門車位」",
        bg: "在澳門找車位，常常得靠運氣。這個專案把交通事務局公開的即時停車場數據，整理成一個人人都能一眼看懂的網頁，讓「找車位」這件小事變得更輕鬆。",
        blocks: [
          { t: "我們做這個的用意", d: "讓一般駕駛人出門前就能知道哪裡還有空位、什麼時候最擠，把時間花在更重要的事上，而不是繞著街區找車位。" },
          { t: "適合誰用", d: "所有在澳門開車或騎電單車的人——上班族、家長、遊客，任何不想浪費時間找車位的人。" },
          { t: "數據從哪裡來", d: "數據來自澳門交通事務局（DSAT）公開的即時資訊，每 30 分鐘自動更新一次。我們只是把這些公開資料整理得更易讀。" },
          { t: "它是怎麼運作的", d: "系統會定時自動讀取官方公布的各停車場剩餘車位，整理後顯示在這個網站上。你不需要安裝任何應用程式或註冊帳號。" },
          { t: "一點說明", d: "這是一個由個人業餘維護的獨立專案，與澳門特別行政區政府或交通事務局沒有隸屬關係。網站免費、無廣告。" }
        ],
        back1: "回到首頁",
        back2: "前往即時查詢"
      }
    },

    "en": {
      brand: "Macau Parking",
      nav: { features: "Features", faq: "FAQ", about: "About" },
      cta: "Check live spaces",
      hero: {
        eyebrow: "Macao public carparks · live info",
        titlePre: "Before you head out, see where",
        titleHi: "parking is still available",
        lead: "Check real-time available spaces at public carparks across Macao, updated automatically every 30 minutes. Data comes from Macao's Transport Bureau.",
        cta: "Check live spaces",
        about: "About this project",
        trust: ["Updated every 30 minutes", "Source: Macao Transport Bureau (DSAT)", "Just open it on your phone"]
      },
      features: {
        kicker: "Features",
        title: "One page that handles all your parking needs",
        sub: "No install, no sign-up — just open and use.",
        items: [
          { t: "Live availability", d: "See at a glance how many spaces are left in each carpark — no more arriving to find it full." },
          { t: "How full, at a glance", d: "Color and percentage show how full a carpark is — red means nearly full." },
          { t: "Avoid the rush", d: "See which times of the week are busiest, and plan to go when it's quieter." },
          { t: "Find it on a map", d: "See nearby carparks and how busy they are right on a map, and pick the most convenient stop." }
        ]
      },
      stats: {
        title: "Covers all of Macao, anytime",
        items: [
          { n: "90+", l: "public carparks" },
          { n: "30 min", l: "auto-refresh" },
          { n: "2 types", l: "cars & motorcycles" }
        ]
      },
      use: {
        kicker: "When it helps",
        title: "When do you need it?",
        sub: "If you drive or ride in Macao, it can help.",
        items: [
          { t: "Commuting", d: "Heading to work in the morning? Check if there's space near the office first, and skip circling the block." },
          { t: "Weekend outings", d: "Going to attractions or shopping areas on holidays? Avoid the most crowded carparks." },
          { t: "Pick-ups & drop-offs", d: "Picking up family from the hospital, school or airport? Preview available spaces and stay calm." }
        ]
      },
      how: {
        kicker: "How to use",
        title: "Three steps to check parking",
        sub: "",
        steps: [
          { t: "Pick your vehicle", d: "First choose whether you're in a car or on a motorcycle." },
          { t: "Search a place", d: "Type a carpark name or district to quickly find the one you want." },
          { t: "See live spaces", d: "Tap in to view remaining spaces, how full it is, and the quietest times." }
        ]
      },
      faq: {
        kicker: "FAQ",
        title: "Common questions",
        items: [
          { q: "Is the data accurate?", a: "The data comes from the real-time feed of Macao's Transport Bureau (DSAT) and is refreshed automatically every 30 minutes. Actual availability may shift slightly as vehicles move in and out, so treat it as a guide." },
          { q: "Is it free? Do I need to register?", a: "Completely free. No registration or download — just open it in your phone's browser." },
          { q: "Which carparks are covered?", a: "Public carparks across all districts of Macao, including the peninsula and the islands. Some private carparks may not be listed." },
          { q: "Is this an official website?", a: "No. This is an independent project maintained by an individual, simply making the public data easier to read and use." },
          { q: "How often is it updated?", a: "Automatically every 30 minutes, so the numbers you see are kept as up to date as possible." }
        ]
      },
      preview: [
        { n: "Downtown", free: 18, cap: 120 },
        { n: "Near attractions", free: 4, cap: 90 },
        { n: "Residential", free: 52, cap: 200 },
        { n: "Shopping mall", free: 9, cap: 150 }
      ],
      foot: {
        tag: "We turn Macao's real-time parking data into a webpage anyone can read at a glance.",
        col1: "Website",
        links: [
          { t: "Live spaces", h: "index.html" },
          { t: "About", h: "about.html" }
        ],
        disclaim: "This is not an official website of the Macao SAR Government. Data source: Macao Transport Bureau (DSAT).",
        copy: "© 2026 Macau Parking · Data auto-refreshed every 30 minutes"
      },
      about: {
        kicker: "About this project",
        title: "About Macau Parking",
        bg: "Finding a parking space in Macao often feels like a matter of luck. This project takes the real-time carpark data published by the Transport Bureau and turns it into a simple webpage anyone can read at a glance — making the small task of finding parking a little easier.",
        blocks: [
          { t: "Why we built it", d: "So everyday drivers can know before leaving home where spaces are free and when it's busiest — and spend time on what matters, not circling for a spot." },
          { t: "Who it's for", d: "Anyone who drives or rides a motorcycle in Macao — commuters, parents, visitors, anyone who'd rather not waste time hunting for a space." },
          { t: "Where the data comes from", d: "The data comes from the public real-time feed of Macao's Transport Bureau (DSAT), refreshed automatically every 30 minutes. We simply make that public data easier to read." },
          { t: "How it works", d: "The system periodically reads the remaining spaces published by the authorities for each carpark, organizes them, and shows them on this site. You don't need to install any app or create an account." },
          { t: "A note", d: "This is an independent, hobby project maintained by an individual, with no affiliation to the Macao SAR Government or the Transport Bureau. The site is free and ad-free." }
        ],
        back1: "Back to home",
        back2: "Go to live check"
      }
    },

    "pt": {
      brand: "Vagas Macau",
      nav: { features: "Funcionalidades", faq: "Perguntas", about: "Sobre" },
      cta: "Ver vagas em tempo real",
      hero: {
        eyebrow: "Parques públicos de Macau · info em tempo real",
        titlePre: "Antes de sair, veja onde",
        titleHi: "ainda há lugares em Macau",
        lead: "Consulte em tempo real as vagas disponíveis nos parques de estacionamento públicos de Macau, atualizado automaticamente a cada 30 minutos. Os dados vêm da Direção dos Serviços para os Assuntos de Tráfego (DSAT).",
        cta: "Ver vagas em tempo real",
        about: "Sobre este projeto",
        trust: ["Atualizado a cada 30 minutos", "Fonte: DSAT (Macau)", "Basta abrir no telemóvel"]
      },
      features: {
        kicker: "Funcionalidades",
        title: "Uma página que resolve o estacionamento",
        sub: "Sem instalar, sem registo — abra e use.",
        items: [
          { t: "Vagas em tempo real", d: "Veja de relance quantas vagas restam em cada parque — sem chegar e encontrá-lo cheio." },
          { t: "Quão cheio, à primeira vista", d: "A cor e a percentagem mostram quanto o parque está cheio — vermelho significa quase cheio." },
          { t: "Evite as horas de ponta", d: "Veja as alturas mais concorridas da semana e planeie sair quando há menos gente." },
          { t: "Encontre no mapa", d: "Veja no mapa os parques próximos e quão ocupados estão, e escolha a paragem mais conveniente." }
        ]
      },
      stats: {
        title: "Cobre Macau inteiro, a qualquer hora",
        items: [
          { n: "90+", l: "parques públicos" },
          { n: "30 min", l: "atualização automática" },
          { n: "2 tipos", l: "carros e motociclos" }
        ]
      },
      use: {
        kicker: "Quando ajuda",
        title: "Quando é útil?",
        sub: "Se conduz ou anda de mota em Macau, pode ajudar.",
        items: [
          { t: "Deslocações diárias", d: "De manhã a caminho do trabalho? Confira se ainda há lugar perto do escritório e evite dar voltas." },
          { t: "Passeios de fim de semana", d: "Vai a pontos turísticos ou centros comerciais ao fim de semana? Evite os parques mais concorridos." },
          { t: "Levar e buscar família", d: "Vai buscar familiares ao hospital, escola ou aeroporto? Veja as vagas antes e fique tranquilo." }
        ]
      },
      how: {
        kicker: "Como usar",
        title: "Três passos para consultar",
        sub: "",
        steps: [
          { t: "Escolha o veículo", d: "Primeiro, indique se vai de carro ou de motociclo." },
          { t: "Procure um local", d: "Escreva o nome do parque ou a zona para encontrar rapidamente o que quer." },
          { t: "Veja as vagas em tempo real", d: "Toque para ver as vagas restantes, quanto está cheio e as alturas mais calmas." }
        ]
      },
      faq: {
        kicker: "Perguntas frequentes",
        title: "Dúvidas comuns",
        items: [
          { q: "Os dados são precisos?", a: "Os dados vêm da informação em tempo real da DSAT e são atualizados automaticamente a cada 30 minutos. A disponibilidade real pode variar um pouco com a entrada e saída de veículos, por isso considere como referência." },
          { q: "É pago? Preciso de registo?", a: "Totalmente gratuito. Sem registo nem download — basta abrir no navegador do telemóvel." },
          { q: "Que parques estão incluídos?", a: "Parques públicos de todas as zonas de Macau, incluindo a península e as ilhas. Alguns parques privados podem não figurar na lista." },
          { q: "É um site oficial?", a: "Não. É um projeto independente mantido por um particular, que apenas torna os dados públicos mais fáceis de ler e usar." },
          { q: "Com que frequência é atualizado?", a: "Automaticamente a cada 30 minutos, para que os números que vê estejam o mais atualizados possível." }
        ]
      },
      preview: [
        { n: "Centro", free: 18, cap: 120 },
        { n: "Zona turística", free: 4, cap: 90 },
        { n: "Residencial", free: 52, cap: 200 },
        { n: "Centro comercial", free: 9, cap: 150 }
      ],
      foot: {
        tag: "Transformamos os dados de estacionamento em tempo real de Macau numa página que qualquer pessoa percebe de imediato.",
        col1: "Site",
        links: [
          { t: "Vagas em tempo real", h: "index.html" },
          { t: "Sobre", h: "about.html" }
        ],
        disclaim: "Este não é um site oficial do Governo da RAEM. Fonte de dados: DSAT (Direção dos Serviços para os Assuntos de Tráfego).",
        copy: "© 2026 Vagas Macau · Dados atualizados automaticamente a cada 30 min"
      },
      about: {
        kicker: "Sobre o projeto",
        title: "Sobre o «Vagas Macau»",
        bg: "Encontrar lugar para estacionar em Macau costuma depender da sorte. Este projeto recolhe os dados em tempo real publicados pela DSAT e transforma-os numa página simples que qualquer pessoa percebe de imediato — tornando a tarefa de estacionar um pouco mais fácil.",
        blocks: [
          { t: "Porquê criámos isto", d: "Para que quem conduz saiba, antes de sair de casa, onde há vagas e quando há mais concorrência — e gaste o tempo no que importa, não a dar voltas à procura de lugar." },
          { t: "Para quem é", d: "Para quem conduz ou anda de mota em Macau — trabalhadores, pais, visitantes, qualquer pessoa que prefira não perder tempo à procura de lugar." },
          { t: "De onde vêm os dados", d: "Os dados vêm da informação pública em tempo real da DSAT, atualizada automaticamente a cada 30 minutos. Apenas tornamos esses dados públicos mais fáceis de ler." },
          { t: "Como funciona", d: "O sistema lê periodicamente as vagas restantes publicadas pelas autoridades para cada parque, organiza-as e mostra-as neste site. Não precisa de instalar app nem criar conta." },
          { t: "Uma nota", d: "Este é um projeto independente e de hobby mantido por um particular, sem qualquer vínculo com o Governo da RAEM ou com a DSAT. O site é gratuito e sem publicidade." }
        ],
        back1: "Voltar ao início",
        back2: "Ir consultar agora"
      }
    }
  };

  var LANGS = [
    { code: "zh-Hant", label: "中文" },
    { code: "en", label: "English" },
    { code: "pt", label: "Português" }
  ];
  var STORE_KEY = "nexus-lang";

  function detectLang() {
    try {
      var saved = localStorage.getItem(STORE_KEY);
      if (saved && I18N[saved]) return saved;
    } catch (e) {}
    var nav = (navigator.language || "zh-Hant").toLowerCase();
    if (nav.indexOf("pt") === 0) return "pt";
    if (nav.indexOf("zh") === 0) return "zh-Hant";
    if (nav.indexOf("en") === 0) return "en";
    return "zh-Hant";
  }

  function get(dict, path) {
    var cur = dict, parts = path.split(".");
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return null;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function applyStatic(lang) {
    var d = I18N[lang];
    document.documentElement.lang = lang;

    // 簡單的 data-i18n 文字節點
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var val = get(d, nodes[i].getAttribute("data-i18n"));
      if (val != null) nodes[i].textContent = val;
    }

    // 頁面標題
    if (document.querySelector('meta[name="description"]')) {
      document.querySelector('meta[name="description"]').setAttribute("content", get(d, "hero.lead") || "");
    }
    document.title = get(d, "about") && document.body.dataset.page === "about"
      ? (get(d, "brand") + " · " + get(d, "about.title"))
      : (get(d, "brand") + " · " + get(d, "hero.titleHi"));

    // 語言下拉
    var sel = document.getElementById("lang");
    if (sel) sel.value = lang;
  }

  function renderList(containerId, items, makeHtml) {
    var el = document.getElementById(containerId);
    if (!el || !items) return;
    el.innerHTML = items.map(makeHtml).join("");
  }

  function renderDynamic(lang) {
    var d = I18N[lang];

    // 功能
    renderList("features-grid", d.features.items, function (it) {
      return '<div class="card feat">' +
        '<div class="ico">' + ICONS.feature + "</div>" +
        "<h3>" + esc(it.t) + "</h3><p>" + esc(it.d) + "</p></div>";
    });

    // Hero 信任標籤
    renderList("trust", d.hero.trust, function (t) {
      return '<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' + esc(t) + "</span>";
    });

    // Hero 預覽卡（裝飾用）
    renderList("preview", d.preview, function (it) {
      var rem = it.cap ? it.free / it.cap : 0;
      var hue = Math.round(140 * rem);
      return '<div class="prow"><span class="pn">' + esc(it.n) + "</span>" +
        '<span class="pbar"><i style="width:' + (rem * 100).toFixed(0) + "%;background:hsl(" + hue + ',62%,48%)"></i></span>' +
        '<span class="pnum">' + it.free + "<small>/" + it.cap + "</small></span></div>";
    });

    // 數據帶
    renderList("stats-grid", d.stats.items, function (it, i) {
      var sep = i > 0 ? '<div class="sep"></div>' : "";
      return sep + '<div><div class="num">' + esc(it.n) + '</div><div class="lbl">' + esc(it.l) + "</div></div>";
    });

    // 使用情境
    renderList("use-grid", d.use.items, function (it) {
      return '<div class="card uc">' +
        '<div class="badge">' + ICONS.use + "</div>" +
        "<h3>" + esc(it.t) + "</h3><p>" + esc(it.d) + "</p></div>";
    });

    // 步驟
    renderList("how-grid", d.how.steps, function (it, i) {
      return '<div class="card step"><div class="n">' + (i + 1) + "</div>" +
        "<div><h3>" + esc(it.t) + "</h3><p>" + esc(it.d) + "</p></div></div>";
    });

    // FAQ
    renderList("faq-list", d.faq.items, function (it) {
      return "<details><summary>" + esc(it.q) +
        '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' +
        "</summary><div class=\"ans\">" + esc(it.a) + "</div></details>";
    });

    // 專案介紹
    renderList("about-blocks", d.about.blocks, function (it) {
      return '<div class="about-block"><div class="ico">' + ICONS.about + "</div>" +
        "<div><h3>" + esc(it.t) + "</h3><p>" + esc(it.d) + "</p></div></div>";
    });
  }

  var ICONS = {
    feature: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    use: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17h14M6.5 17V9.5A2 2 0 018.5 7.5h3.2a2 2 0 012 2.3L13 10M9 7.5V6M4 20h16"/></svg>',
    about: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.2"/></svg>'
  };

  function setLang(lang) {
    if (!I18N[lang]) lang = "zh-Hant";
    try { localStorage.setItem(STORE_KEY, lang); } catch (e) {}
    applyStatic(lang);
    renderDynamic(lang);
  }

  function init() {
    var sel = document.getElementById("lang");
    if (sel) {
      sel.innerHTML = LANGS.map(function (l) {
        return '<option value="' + l.code + '">' + l.label + "</option>";
      }).join("");
      sel.addEventListener("change", function () { setLang(sel.value); });
    }
    setLang(detectLang());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
