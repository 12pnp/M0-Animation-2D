import { h, on } from "@/view/widgets/dom";
import appSvg from "@/assets/boneburst-logo.svg?raw";
// The mark alone, not the full lockup: at this size the "morenoise" lettering
// in the lockup is a grey smudge. The name is right beside it as real text.
import logoSvg from "@/assets/morenoise-mark.svg?raw";
import {
  APP_NAME, APP_TAGLINE, APP_VERSION, CREDITS, LICENSE_ID, LICENSE_NOTE,
  ORIGIN_AUTHOR, ORIGIN_AUTHOR_URL, ORIGIN_NAME, ORIGIN_REPO_URL, REPO_URL,
  BONEBURST_NOTE, TRADEMARK_NOTE,
} from "@/core/about";

function link(href: string, text: string, cls = "about-link"): HTMLAnchorElement {
  return h("a", { class: cls, href, target: "_blank", rel: "noopener noreferrer" }, text);
}

/**
 * Who made this and what it stands on: Preferences ▸ About, which the app
 * icon opens. The wording lives in `core/about.ts` so the README and the
 * notices file quote the same text.
 */
export function renderAbout(pane: HTMLElement): void {
  const body = h("div", { class: "about" });
  pane.appendChild(body);

  // Injected with `innerHTML` rather than `svg()` from dom.ts, which forces a
  // 16x16 viewBox. The app icon carries its own rounded-square background; the
  // Morenoise mark is drawn for light backgrounds, so its white disc is CSS.
  const appIcon = h("div", { class: "about-icon" });
  appIcon.innerHTML = appSvg;
  const mark = h("span", { class: "about-mark" });
  mark.innerHTML = logoSvg;

  body.appendChild(h("div", { class: "about-hero" },
    appIcon,
    h("div", { class: "about-name" }, APP_NAME),
    h("div", { class: "about-tag" }, APP_TAGLINE),
    h("span", { class: "about-ver" }, `Version ${APP_VERSION}`),
  ));

  body.appendChild(h("a", {
    class: "about-maker", href: ORIGIN_AUTHOR_URL, target: "_blank", rel: "noopener noreferrer",
  },
    mark,
    h("span", { class: "about-maker-text" },
      h("span", { class: "about-maker-by" }, "Built from"),
      h("span", { class: "about-maker-name" }, `${ORIGIN_NAME} by ${ORIGIN_AUTHOR}`),
    ),
    h("span", { class: "about-maker-url" }, ORIGIN_AUTHOR_URL.replace(/^https:\/\//, "")),
  ));

  body.appendChild(h("div", { class: "about-links" },
    link(REPO_URL, "Source code"),
    link(ORIGIN_REPO_URL, `${ORIGIN_NAME} source`),
  ));

  body.appendChild(h("h4", null, "How it works"));
  body.appendChild(h("p", null, BONEBURST_NOTE));

  body.appendChild(h("h4", null, "Credits"));
  const list = h("ul", { class: "about-credits" });
  for (const c of CREDITS) {
    list.appendChild(h("li", null,
      link(c.url, c.version ? `${c.name} ${c.version}` : c.name, "about-credit-name"),
      h("span", { class: "about-lic" }, c.license),
      h("span", { class: "about-credit-what" }, c.what),
    ));
  }
  body.appendChild(list);

  body.appendChild(h("h4", null, "License"));
  body.appendChild(h("p", null, LICENSE_NOTE));
  body.appendChild(h("p", { class: "about-lic-links" },
    link(`${REPO_URL}/blob/main/LICENSE`, LICENSE_ID), " · ",
    link(`${REPO_URL}/blob/main/LICENSE-EXCEPTION.md`, "Export exception"),
  ));

  body.appendChild(h("p", { class: "about-note" }, TRADEMARK_NOTE));

  const copy = h("button", { class: "btn" }, "Copy version info");
  on(copy, "pointerup", () => {
    const text = [
      `${APP_NAME} ${APP_VERSION}`,
      APP_TAGLINE,
      ...CREDITS.map((c) => `${c.name}${c.version ? ` ${c.version}` : ""} (${c.license})`),
      navigator.userAgent,
    ].join("\n");
    void navigator.clipboard?.writeText(text).then(
      () => { copy.textContent = "Copied"; },
      () => { copy.textContent = "Copy failed"; },
    );
  });
  body.appendChild(h("div", { class: "about-copy" }, copy));
}
