// Content script : liste les éléments interactifs de la page et exécute les actions demandées.
// Injecté à la demande par background.js, d'où la garde contre une double injection.
(() => {
  if (window.__jevBridgeLoaded) return;
  window.__jevBridgeLoaded = true;

  const INTERACTIVE = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=menuitemcheckbox]",
    "[role=menuitemradio]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=option]",
    "[role=combobox]", "[role=textbox]", "[role=searchbox]", "[role=treeitem]",
    "[contenteditable='']", "[contenteditable=true]", "[onclick]",
  ].join(",");

  const ZONES = [
    "nav", "header", "footer", "main", "aside", "form", "dialog",
    "[role=navigation]", "[role=banner]", "[role=contentinfo]", "[role=main]", "[role=complementary]",
    "[role=search]", "[role=dialog]", "[role=menu]", "[role=tablist]",
  ].join(",");

  // Longueur des libellés d'options envoyés dans le snapshot, et donc acceptés par selectOption.
  const OPTION_LABEL_MAX = 40;

  // ref -> élément, remis à zéro à chaque snapshot : les refs ne valent que pour le dernier snapshot.
  let refs = new Map();
  // section/article -> son titre, recalculé à chaque snapshot : les éléments d'une section le partagent.
  let headings = new Map();

  const clean = (s, max = 80) => (s || "").replace(/\s+/g, " ").trim().slice(0, max);
  const formOf = (el) => el.form || el.closest("form");
  const pageText = () => (document.body ? document.body.innerText : "");

  function collect(root, out) {
    for (const el of root.querySelectorAll(INTERACTIVE)) out.add(el);
    for (const host of root.querySelectorAll("*")) {
      // openOrClosedShadowRoot est propre à Firefox et visible uniquement des extensions.
      const shadow = host.openOrClosedShadowRoot || host.shadowRoot;
      if (shadow) collect(shadow, out);
    }
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    return !el.closest("[aria-hidden=true], [inert]");
  }

  function textOfId(id) {
    const node = document.getElementById(id);
    return node ? node.innerText || node.textContent : "";
  }

  function accessibleName(el) {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = clean(labelledBy.split(/\s+/).map(textOfId).join(" "));
      if (t) return t;
    }
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (el.labels && el.labels.length) {
      const t = clean([...el.labels].map((l) => l.innerText).join(" "));
      if (t) return t;
    }
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) {
      const v = clean(el.value);
      if (v) return v;
    }
    const text = clean(el.innerText);
    if (text) return text;
    const img = el.querySelector("img[alt], svg title");
    if (img) {
      const t = clean(img.getAttribute("alt") || img.textContent);
      if (t) return t;
    }
    return clean(el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("name"));
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "search") return "searchbox";
      if (type === "range") return "slider";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "button";
  }

  function zoneOf(el) {
    const zone = el.parentElement && el.parentElement.closest(ZONES);
    if (!zone) return undefined;
    const kind = zone.getAttribute("role") || zone.tagName.toLowerCase();
    const label = clean(zone.getAttribute("aria-label"), 30);
    return label ? `${kind} "${label}"` : kind;
  }

  function sectionOf(el) {
    const section = el.closest("section, article");
    if (!section) return undefined;
    if (!headings.has(section)) {
      const node = section.querySelector("h1, h2, h3, h4");
      headings.set(section, node && { node, text: clean(node.innerText, 50) || undefined });
    }
    const heading = headings.get(section);
    return heading && !heading.node.contains(el) ? heading.text : undefined;
  }

  function shortHref(el) {
    try {
      const url = new URL(el.href);
      if (url.protocol === "javascript:") return undefined;
      // L'ancre compte : sans elle, les liens d'une table des matières sembleraient tous identiques.
      const path = url.pathname + url.search + url.hash;
      return clean(url.origin === location.origin ? path : url.host + path, 70);
    } catch {
      return undefined;
    }
  }

  // Champ où Entrée lance une recherche. Ailleurs (connexion, formulaire), Entrée enverrait un formulaire incomplet.
  function isSearchField(el) {
    if (el.type === "search" || el.getAttribute("role") === "searchbox") return true;
    if (el.closest("[role=search], search")) return true;
    const form = formOf(el);
    const hints = [el.name, el.id, el.getAttribute("aria-label"), el.placeholder, form && form.getAttribute("action")];
    return /search|recherch|query|chercher|\bq\b/i.test(hints.filter(Boolean).join(" "));
  }

  function describeElement(el, ref) {
    const r = el.getBoundingClientRect();
    const item = {
      ref,
      role: roleOf(el),
      name: accessibleName(el),
      inViewport: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
    };
    if (el.tagName === "A") {
      item.href = shortHref(el);
      item.url = el.href;
    }
    if (el.tagName === "INPUT" && el.type) item.type = el.type;
    if (el.tagName === "INPUT" && isSearchField(el)) item.search = true;
    if (el.placeholder) item.placeholder = clean(el.placeholder, 50);
    if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.value && !["button", "submit", "reset", "password", "checkbox", "radio"].includes(el.type)) {
      item.value = clean(el.value, 40);
    }
    if (el.tagName === "SELECT") {
      item.value = clean(el.selectedOptions[0] && el.selectedOptions[0].text, 40);
      item.options = [...el.options].slice(0, 20).map((o) => clean(o.text, OPTION_LABEL_MAX));
    }
    if (el.type === "checkbox" || el.type === "radio") item.checked = el.checked;
    else if (el.hasAttribute("aria-checked")) item.checked = el.getAttribute("aria-checked") === "true";
    if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
    // Dit à Jev qu'un bouton de navigation déplie un menu plutôt que d'ouvrir une page.
    const expanded = el.getAttribute("aria-expanded");
    if (expanded === "true" || expanded === "false") item.expanded = expanded === "true";
    else if (el.tagName === "SUMMARY" && el.parentElement && el.parentElement.tagName === "DETAILS") item.expanded = el.parentElement.open;
    const popup = el.getAttribute("aria-haspopup");
    if (popup && popup !== "false") item.popup = popup === "true" ? "menu" : popup;
    const zone = zoneOf(el);
    if (zone) item.zone = zone;
    const section = sectionOf(el);
    if (section) item.section = section;
    return item;
  }

  function snapshot({ limit = 1000 }) {
    refs = new Map();
    headings = new Map();
    const found = new Set();
    collect(document, found);
    const elements = [];
    for (const el of found) {
      if (elements.length >= limit) break;
      if (!isVisible(el)) continue;
      // Un élément imbriqué dans un lien ou un bouton ferait doublon avec son parent.
      if (el.parentElement && el.parentElement.closest("a[href], button")) continue;
      const ref = `e${elements.length + 1}`;
      refs.set(ref, el);
      elements.push(describeElement(el, ref));
    }
    return {
      url: location.href,
      title: document.title,
      elements,
      total: found.size,
      truncated: elements.length >= limit,
      text: clean(pageText(), 2000),
    };
  }

  function getElement(ref) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) {
      throw new Error(`Élément ${ref} introuvable : la page a changé, il faut refaire un snapshot`);
    }
    return el;
  }

  function click(el) {
    // browse_goal suit un seul onglet : un lien prévu pour un nouvel onglet s'ouvre dans celui-ci.
    const link = el.closest("a[href]");
    const target = link && link.getAttribute("target");
    if (target && target !== "_self") link.setAttribute("target", "_self");
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerover", pointer));
    el.dispatchEvent(new MouseEvent("mouseover", base));
    el.dispatchEvent(new PointerEvent("pointerdown", pointer));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    if (typeof el.focus === "function") el.focus();
    el.dispatchEvent(new PointerEvent("pointerup", pointer));
    el.dispatchEvent(new MouseEvent("mouseup", base));
    // click() déclenche l'événement click et l'action par défaut (navigation, submit, case à cocher).
    el.click();
    // La navigation est décidée pendant click() : on peut remettre la cible d'origine.
    if (target && target !== "_self") link.setAttribute("target", target);
  }

  function setValue(el, text) {
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (el.isContentEditable) {
      document.execCommand("selectAll");
      document.execCommand("insertText", false, text);
      return;
    }
    // Setter natif : les frameworks type React ne voient pas une affectation directe à value.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressEnter(el) {
    const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    const notHandled = el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    // Un Enter synthétique ne soumet pas le formulaire tout seul, sauf si la page l'a déjà géré.
    const form = formOf(el);
    if (notHandled && form) {
      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
    }
  }

  function selectOption(el, text) {
    const wanted = text.toLowerCase();
    // Les libellés du snapshot sont tronqués : on accepte aussi cette forme.
    const option = [...el.options].find(
      (o) => o.value === text || clean(o.text).toLowerCase() === wanted || clean(o.text, OPTION_LABEL_MAX).toLowerCase() === wanted,
    );
    if (!option) throw new Error(`Option "${text}" absente de la liste`);
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return clean(option.text);
  }

  function act({ ref, action, text, submit }) {
    const el = getElement(ref);
    const target = `${roleOf(el)} "${accessibleName(el)}"`;
    if (action === "click") {
      click(el);
    } else if (action === "type") {
      if (typeof text !== "string") throw new Error("Le paramètre text est obligatoire pour type");
      setValue(el, text);
      if (submit) pressEnter(el);
    } else if (action === "select") {
      if (el.tagName !== "SELECT") throw new Error(`${ref} n'est pas une liste déroulante`);
      return { action, target, selected: selectOption(el, String(text)) };
    } else {
      throw new Error(`Action inconnue : ${action}`);
    }
    return { action, target };
  }

  function readText({ maxChars = 8000 }) {
    return pageText().replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim().slice(0, maxChars);
  }

  function scroll({ direction }) {
    window.scrollBy({ top: (direction === "up" ? -1 : 1) * innerHeight * 0.8, behavior: "instant" });
    return { scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight };
  }

  const handlers = { snapshot, act, read_text: readText, scroll };

  browser.runtime.onMessage.addListener((msg) => {
    try {
      const handler = handlers[msg.cmd];
      if (!handler) throw new Error(`Commande inconnue : ${msg.cmd}`);
      return Promise.resolve({ ok: true, result: handler(msg.args || {}) });
    } catch (err) {
      return Promise.resolve({ ok: false, error: err.message || String(err) });
    }
  });
})();
