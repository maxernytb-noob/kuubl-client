// Kuubl Client site: language switch, launcher tabs, OS-aware download button, version from latest.json.
(() => {
  const html = document.documentElement;
  const langBtn = document.getElementById("lang");

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
  };

  const setLang = (l) => {
    html.lang = l;
    langBtn.textContent = l === "en" ? "CZ" : "EN";
    langBtn.setAttribute("aria-label", l === "en" ? "Čeština" : "English");
    store.set("kuubl-lang", l);
  };
  const q = new URLSearchParams(location.search).get("lang");
  const nav = navigator.language || "";
  setLang((q === "en" || q === "cs" ? q : null) || store.get("kuubl-lang") || (nav && !/^(cs|sk)/i.test(nav) ? "en" : "cs"));
  langBtn.addEventListener("click", () => setLang(html.lang === "en" ? "cs" : "en"));

  // Launcher tabs
  const tabs = [...document.querySelectorAll(".tab")];
  const imgs = [...document.querySelectorAll("#lview img")];
  const select = (i) => {
    tabs.forEach((t, n) => t.setAttribute("aria-selected", String(n === i)));
    imgs.forEach((im, n) => im.classList.toggle("on", n === i));
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(i));
    t.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
      const n = (i + d + tabs.length) % tabs.length;
      select(n); tabs[n].focus();
    });
  });

  // Hero download follows the visitor's system: Windows gets the installer, everyone else the list.
  const plat = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "") + " " + navigator.userAgent;
  const os = /Android|iPhone|iPad/i.test(plat) ? "other" : /Win/i.test(plat) ? "win" : /Linux|X11|CrOS/i.test(plat) ? "linux" : "other";
  const main = document.getElementById("dl-main");
  if (os !== "win") {
    main.removeAttribute("download");
    main.href = os === "linux" ? "#row-deb" : "#download";
    main.innerHTML = os === "linux"
      ? '<span data-cs>Stáhnout pro Linux</span><span data-en>Download for Linux</span>'
      : '<span data-cs>Stáhnout</span><span data-en>Download</span>';
    const alt = document.getElementById("dl-alt");
    alt.href = "#row-win";
    alt.innerHTML = '<span data-cs>Verze pro Windows</span><span data-en>Windows build</span>';
  }

  // Current version, if latest.json is next to the page.
  fetch("latest.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((j) => {
      if (!j || !j.version) return;
      document.querySelectorAll("[data-ver]").forEach((el) => { el.textContent = "v" + j.version; });
    })
    .catch(() => {});
})();
