/* landing.js — 落地頁 / 專案介紹頁 共用多語引擎
 *
 * 三種語言：中文（繁體，澳門習用）、English、Português。
 * 文案全部放在 I18N 裡；頁面載入時依 localStorage → 瀏覽器語言 → 中文 決定預設，
 * 並提供下拉切換。落地頁與專案介紹頁共用同一份字典，各頁只取自己用到的鍵。
 *
 * 圖片：一律使用 Unsplash CDN 的直連網址（免費商用、可熱連結），
 * 由 IMAGES + unsplash() 依尺寸參數組出，避免寫死長網址。
 */
(function () {
  "use strict";

  /* ---------- 圖片（Unsplash 直連，免費商用）---------- */
  var IMAGES = {
    hero:     "1503891450247-ee5f8ec46dc3",
    vp:       "1542836038-80751c534e12",
    useWork:  "1515165562839-978bbcf18277",
    useFun:   "1520250497591-112f2f40a3f4",
    useCity:  "1439396087961-98bc12c21176",
    ava1:     "1544005313-94ddf0286df2",
    ava2:     "1607746882042-944635dfe10e",
    ava3:     "1506794778202-cad84cf45f1d"
  };
  // w=寬、q=品質；方形頭像另加 h + crop=faces（Unsplash imgix 參數）
  function unsplash(key, w, q) {
    var id = IMAGES[key];
    var base = "https://images.unsplash.com/photo-" + id + "?auto=format&fit=crop&w=" + (w || 800) + "&q=" + (q || 76);
    if (key.indexOf("ava") === 0) base += "&h=" + (w || 800) + "&crop=faces";
    return base;
  }

  /* ---------- 字典 ---------- */
  var I18N = {
    "zh-Hant": {
      brand: "澳門車位",
      nav: { features: "功能", proof: "評價", faq: "常見問題", about: "專案介紹" },
      cta: "查看即時車位",
      hero: {
        eyebrow: "澳門公共停車場 · 實時資訊",
        titlePre: "出門前，先看澳門",
        titleHi: "哪裡還有車位",
        lead: "即時查詢全澳公共停車場的剩餘空位，每 30 分鐘自動更新。數據來自澳門交通事務局官方資訊。",
        cta: "查看即時車位",
        about: "了解這個專案",
        imgAlt: "黃昏時分，一條兩旁種滿棕櫚樹的城市道路，路邊停放著一排汽車",
        trust: ["每 30 分鐘自動更新", "數據來源：澳門交通事務局 DSAT", "手機直接打開就用"]
      },
      heroFloat: { s: "全澳公共停車場" },
      heroCard: { label: "全澳即時使用率", live: "即時", note: "示範畫面 · 實際數字以查詢頁為準" },
      logoband: ["免費使用", "免註冊", "中文 · English · Português", "覆蓋澳門半島與離島"],
      vp: {
        kicker: "為什麼用它",
        title: "把「找車位」變成一件小事",
        lead: "在澳門開車，最耗時間的往往不是路上，而是到達之後繞著街區找位。這個網站把官方公開的停車數據，變成隨手可查的即時畫面。",
        imgAlt: "一輛紅色小汽車停在綠樹成蔭的街道旁，路邊劃有停車位",
        points: [
          { t: "即時掌握空位", d: "每個停車場還剩多少位、有多滿，一眼看清。" },
          { t: "分開顯示車種", d: "私家車與電單車的車位分開統計，各找各的。" },
          { t: "看懂高峰時段", d: "一週裡哪個時段最難停車，提早避開。" }
        ]
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
      proof: {
        kicker: "使用者怎麼說",
        title: "出門前看一眼，心裡就有底",
        sub: "來自日常駕駛者的真實使用心得。",
        items: [
          { q: "以前去南灣辦事都要繞好幾圈，現在出門前先看一眼，直接去有位的那個場，省下至少十分鐘。", n: "陳先生", r: "私家車車主 · 澳門半島", key: "ava3", alt: "一位男性使用者的頭像" },
          { q: "週末帶小朋友出去，先查哪個停車場沒那麼滿，不用一直在入口排隊。", n: "李小姐", r: "家庭車主 · 氹仔", key: "ava1", alt: "一位女性使用者的頭像" },
          { q: "騎電單車最怕沒位子，這個網站把電單車位也分開顯示，很貼心。", n: "黃先生", r: "電單車使用者 · 路環", key: "ava2", alt: "一位女性使用者的頭像" }
        ]
      },
      use: {
        kicker: "使用情境",
        title: "什麼時候用得上？",
        sub: "只要你在澳門開車或騎車，它都能幫上忙。",
        items: [
          { t: "上班通勤", d: "早上趕著上班，先確認公司附近還有沒有位，省下繞圈找車位的時間。", key: "useWork", alt: "列車停靠月台，乘客正準備上落" },
          { t: "週末出遊", d: "假日去景點或商圈，避開人擠人的熱門停車場。", key: "useFun", alt: "熱帶度假村的泳池與涼亭" },
          { t: "接送家人", d: "去醫院、學校或機場接送，提前看好空位不慌張。", key: "useCity", alt: "俯瞰城市，高樓與住宅區在陽光下延伸" }
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
      cta2: { title: "現在就看看，附近還有沒有位", sub: "免費、免註冊，用手機打開就能查。出門前花十秒，省下繞圈的時間。" },
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
      foot: {
        tag: "把澳門交通事務局的即時停車數據，整理成每個人都能一眼看懂的網頁。",
        col1: "網站", col2: "資料", col3: "聯絡我們",
        srcLink: "數據來源與更新", howLink: "運作方式",
        loc: "澳門 Macau", feedback: "回報問題 · 建議",
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
      nav: { features: "Features", proof: "Reviews", faq: "FAQ", about: "About" },
      cta: "Check live spaces",
      hero: {
        eyebrow: "Macao public carparks · live info",
        titlePre: "Before you head out, see where",
        titleHi: "parking is still available",
        lead: "Check real-time available spaces at public carparks across Macao, updated automatically every 30 minutes. Data comes from Macao's Transport Bureau.",
        cta: "Check live spaces",
        about: "About this project",
        imgAlt: "A city road lined with palm trees at sunset, with cars parked along the kerb",
        trust: ["Updated every 30 minutes", "Source: Macao Transport Bureau (DSAT)", "Just open it on your phone"]
      },
      heroFloat: { s: "public carparks in Macao" },
      heroCard: { label: "Live occupancy in Macao", live: "Live", note: "Sample view · real figures on the app page" },
      logoband: ["Free to use", "No sign-up", "Chinese · English · Português", "Covers peninsula & islands"],
      vp: {
        kicker: "Why use it",
        title: "Turn finding parking into an afterthought",
        lead: "When you drive in Macao, the slow part is rarely the road — it's circling the block after you arrive. This site turns public parking data into a live view you can check anywhere.",
        imgAlt: "A red compact car parked on a leafy street beside marked parking bays",
        points: [
          { t: "Live availability", d: "See exactly how many spaces are left and how full each carpark is." },
          { t: "Split by vehicle type", d: "Cars and motorcycles are counted separately, so you check your own." },
          { t: "See the peak hours", d: "Know which hours of the week are hardest to park, and go earlier." }
        ]
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
      proof: {
        kicker: "What users say",
        title: "One glance before you leave says it all",
        sub: "Honest words from everyday drivers.",
        items: [
          { q: "I used to circle the block near Nam Van. Now I check before leaving and drive straight to a carpark that has space — saves me ten minutes.", n: "Mr. Chan", r: "Car owner · Macao Peninsula", key: "ava3", alt: "Portrait of a male user" },
          { q: "On weekends we take the kids out and check which carpark isn't packed first, so we don't queue at the entrance.", n: "Ms. Lei", r: "Family driver · Taipa", key: "ava1", alt: "Portrait of a female user" },
          { q: "As a scooter rider, the thing I dread is having no space. This site shows motorcycle spaces separately too — really thoughtful.", n: "Mr. Wong", r: "Motorcycle rider · Coloane", key: "ava2", alt: "Portrait of a female user" }
        ]
      },
      use: {
        kicker: "When it helps",
        title: "When do you need it?",
        sub: "If you drive or ride in Macao, it can help.",
        items: [
          { t: "Commuting", d: "Heading to work in the morning? Check if there's space near the office first, and skip circling the block.", key: "useWork", alt: "A train at a station platform as passengers board" },
          { t: "Weekend outings", d: "Going to attractions or shopping areas on holidays? Avoid the most crowded carparks.", key: "useFun", alt: "A tropical resort pool with pavilions" },
          { t: "Pick-ups & drop-offs", d: "Picking up family from the hospital, school or airport? Preview available spaces and stay calm.", key: "useCity", alt: "An aerial view of a city with towers and residential blocks" }
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
      cta2: { title: "See what's free near you right now", sub: "Free, no sign-up, works right in your phone's browser. Ten seconds before you leave saves you a lap around the block." },
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
      foot: {
        tag: "We turn Macao's real-time parking data into a webpage anyone can read at a glance.",
        col1: "Website", col2: "Data", col3: "Contact",
        srcLink: "Data source & updates", howLink: "How it works",
        loc: "Macau", feedback: "Report · Suggest",
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
      nav: { features: "Funcionalidades", proof: "Opiniões", faq: "Perguntas", about: "Sobre" },
      cta: "Ver vagas em tempo real",
      hero: {
        eyebrow: "Parques públicos de Macau · info em tempo real",
        titlePre: "Antes de sair, veja onde",
        titleHi: "ainda há lugares em Macau",
        lead: "Consulte em tempo real as vagas disponíveis nos parques de estacionamento públicos de Macau, atualizado automaticamente a cada 30 minutos. Os dados vêm da Direção dos Serviços para os Assuntos de Tráfego (DSAT).",
        cta: "Ver vagas em tempo real",
        about: "Sobre este projeto",
        imgAlt: "Uma avenida ladeada de palmeiras ao pôr do sol, com carros estacionados junto ao passeio",
        trust: ["Atualizado a cada 30 minutos", "Fonte: DSAT (Macau)", "Basta abrir no telemóvel"]
      },
      heroFloat: { s: "parques públicos em Macau" },
      heroCard: { label: "Ocupação em tempo real", live: "Direto", note: "Vista de exemplo · números reais na página de consulta" },
      logoband: ["Gratuito", "Sem registo", "中文 · English · Português", "Península e ilhas"],
      vp: {
        kicker: "Porquê usá-lo",
        title: "Encontrar estacionamento deixa de ser problema",
        lead: "Conduzir em Macau raramente é lento — o pior é andar às voltas depois de chegar. Este site transforma os dados públicos de estacionamento numa vista em tempo real que pode consultar em qualquer lugar.",
        imgAlt: "Um pequeno carro vermelho estacionado numa rua arborizada, junto a lugares demarcados",
        points: [
          { t: "Vagas em tempo real", d: "Veja exatamente quantas vagas restam e quão cheio está cada parque." },
          { t: "Separado por veículo", d: "Carros e motociclos são contados em separado, para ver o seu." },
          { t: "Veja as horas de ponta", d: "Saiba quais as horas mais difíceis da semana e saia mais cedo." }
        ]
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
      proof: {
        kicker: "O que dizem os utilizadores",
        title: "Um olhar antes de sair resolve tudo",
        sub: "Palavras honestas de condutores do dia a dia.",
        items: [
          { q: "Costumava dar várias voltas perto da Nam Van. Agora verifico antes de sair e vou direto a um parque com vagas — poupo dez minutos.", n: "Sr. Chan", r: "Automobilista · Península de Macau", key: "ava3", alt: "Retrato de um utilizador" },
          { q: "Ao fim de semana, saímos com os filhos e vemos primeiro qual o parque menos cheio, para não fazer fila à entrada.", n: "Sra. Lei", r: "Condutora familiar · Taipa", key: "ava1", alt: "Retrato de uma utilizadora" },
          { q: "Como motociclista, o que mais me preocupa é não haver lugar. Este site mostra também as vagas para motas — muito atencioso.", n: "Sr. Wong", r: "Motociclista · Coloane", key: "ava2", alt: "Retrato de uma utilizadora" }
        ]
      },
      use: {
        kicker: "Quando ajuda",
        title: "Quando é útil?",
        sub: "Se conduz ou anda de mota em Macau, pode ajudar.",
        items: [
          { t: "Deslocações diárias", d: "De manhã a caminho do trabalho? Confira se ainda há lugar perto do escritório e evite dar voltas.", key: "useWork", alt: "Um comboio na plataforma enquanto os passageiros entram" },
          { t: "Passeios de fim de semana", d: "Vai a pontos turísticos ou centros comerciais ao fim de semana? Evite os parques mais concorridos.", key: "useFun", alt: "Uma piscina de resort tropical com pavilhões" },
          { t: "Levar e buscar família", d: "Vai buscar familiares ao hospital, escola ou aeroporto? Veja as vagas antes e fique tranquilo.", key: "useCity", alt: "Vista aérea de uma cidade com torres e bairros" }
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
      cta2: { title: "Veja agora o que está livre perto de si", sub: "Gratuito, sem registo, direto no navegador do telemóvel. Dez segundos antes de sair poupam-lhe uma volta ao quarteirão." },
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
      foot: {
        tag: "Transformamos os dados de estacionamento em tempo real de Macau numa página que qualquer pessoa percebe de imediato.",
        col1: "Site", col2: "Dados", col3: "Contacto",
        srcLink: "Fonte e atualizações", howLink: "Como funciona",
        loc: "Macau", feedback: "Reportar · Sugerir",
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

  var ICONS = {
    feature: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.4l2.6 2.6L16 9.6"/></svg>',
    about: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.2"/></svg>',
    star: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.6 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/></svg>',
    band: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
  };

  function applyStatic(lang) {
    var d = I18N[lang];
    document.documentElement.lang = lang;

    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var val = get(d, nodes[i].getAttribute("data-i18n"));
      if (val != null) nodes[i].textContent = val;
    }
    var alts = document.querySelectorAll("[data-i18n-alt]");
    for (var j = 0; j < alts.length; j++) {
      var a = get(d, alts[j].getAttribute("data-i18n-alt"));
      if (a != null) alts[j].setAttribute("alt", a);
    }

    var desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute("content", get(d, "hero.lead") || "");

    var page = document.body.getAttribute("data-page");
    document.title = page === "about"
      ? get(d, "brand") + " · " + get(d, "about.title")
      : get(d, "brand") + " · " + get(d, "hero.titleHi");

    var sel = document.getElementById("lang");
    if (sel) sel.value = lang;
  }

  function renderList(id, items, makeHtml) {
    var el = document.getElementById(id);
    if (!el || !items) return;
    el.innerHTML = items.map(makeHtml).join("");
  }

  function renderDynamic(lang) {
    var d = I18N[lang];

    // Hero 信任標籤
    renderList("trust", d.hero.trust, function (t) {
      return "<span>" + ICONS.band + esc(t) + "</span>";
    });
    // 信任帶
    renderList("logoband", d.logoband, function (t) {
      return "<span>" + ICONS.band + esc(t) + "</span>";
    });
    // 價值主張要點
    renderList("vp-list", d.vp.points, function (it) {
      return '<div class="vp-item"><span class="ico">' + ICONS.check + "</span>" +
        "<div><h3>" + esc(it.t) + "</h3><p>" + esc(it.d) + "</p></div></div>";
    });
    // 功能
    renderList("features-grid", d.features.items, function (it) {
      return '<div class="card feat"><div class="ico">' + ICONS.feature + "</div>" +
        "<h3>" + esc(it.t) + "</h3><p>" + esc(it.d) + "</p></div>";
    });
    // 數據帶
    renderList("stats-grid", d.stats.items, function (it, i) {
      var sep = i > 0 ? '<div class="sep"></div>' : "";
      return sep + '<div class="cell"><div class="num">' + esc(it.n) + '</div><div class="lbl">' + esc(it.l) + "</div></div>";
    });
    // 客戶評價
    renderList("proof-grid", d.proof.items, function (it) {
      return '<div class="card quote">' +
        '<div class="stars">' + ICONS.star + ICONS.star + ICONS.star + ICONS.star + ICONS.star + "</div>" +
        "<p>" + esc(it.q) + "</p>" +
        '<div class="who"><img src="' + unsplash(it.key, 140, 76) + '" alt="' + esc(it.alt) + '" width="46" height="46" loading="lazy" decoding="async">' +
        "<span><b>" + esc(it.n) + "</b><span>" + esc(it.r) + "</span></span></div></div>";
    });
    // 使用情境（圖卡）
    renderList("use-grid", d.use.items, function (it) {
      return '<div class="card uc"><div class="thumb">' +
        '<img src="' + unsplash(it.key, 860, 74) + '" alt="' + esc(it.alt) + '" width="860" height="538" loading="lazy" decoding="async"></div>' +
        '<div class="body"><h3>' + esc(it.t) + "</h3><p>" + esc(it.d) + "</p></div></div>";
    });
    // 步驟
    renderList("how-grid", d.how.steps, function (it, i) {
      return '<div class="card step"><div class="n">' + (i + 1) + "</div>" +
        "<h3>" + esc(it.t) + "</h3><p>" + esc(it.d) + "</p></div>";
    });
    // FAQ
    renderList("faq-list", d.faq.items, function (it) {
      return "<details><summary>" + esc(it.q) +
        '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' +
        '</summary><div class="ans">' + esc(it.a) + "</div></details>";
    });
    // 專案介紹
    renderList("about-blocks", d.about.blocks, function (it) {
      return '<div class="about-block"><div class="ico">' + ICONS.about + "</div>" +
        "<div><h3>" + esc(it.t) + "</h3><p>" + esc(it.d) + "</p></div></div>";
    });
  }

  function setLang(lang) {
    if (!I18N[lang]) lang = "zh-Hant";
    try { localStorage.setItem(STORE_KEY, lang); } catch (e) {}
    applyStatic(lang);
    renderDynamic(lang);
  }

  /* ---------- 進場動畫 / 導覽陰影 ---------- */
  function initMotion() {
    var nav = document.getElementById("nav");
    if (nav) {
      var onScroll = function () {
        if (window.scrollY > 8) nav.classList.add("scrolled");
        else nav.classList.remove("scrolled");
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    }
    var els = document.querySelectorAll(".reveal");
    if (!els.length) return;
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !("IntersectionObserver" in window)) {
      for (var i = 0; i < els.length; i++) els[i].classList.add("in");
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    for (var k = 0; k < els.length; k++) io.observe(els[k]);
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
    initMotion();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
