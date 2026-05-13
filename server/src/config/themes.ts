import chalk from "chalk";
import boxen from "boxen";
import { markedTerminal } from "marked-terminal";
import { loadConfig } from "./ai.config.js";

/**
 * Codiee terminal themes — chalk text roles, boxen border, markdown styles.
 * Color values must be valid chalk/boxen color names.
 */

export const THEME_NAMES = Object.freeze([
  "dark",
  "light",
  "ocean",
  "sunset",
  "mono",
  "nord",
  "synthwave",
]);

export const THEMES = {
  dark: {
    label: "Dark (default)",
    colors: {
      primary: "cyan",
      secondary: "green",
      accent: "magenta",
      info: "blue",
      muted: "gray",
      success: "green",
      warning: "yellow",
      error: "red",
      border: "cyan",
    },
    md: {
      code: "cyan",
      heading: "green",
      firstHeading: "magenta",
      codespan: "yellow",
      link: "blue",
    },
  },
  light: {
    label: "Light",
    colors: {
      primary: "blue",
      secondary: "green",
      accent: "magenta",
      info: "blue",
      muted: "gray",
      success: "green",
      warning: "yellow",
      error: "red",
      border: "blue",
    },
    md: {
      code: "blue",
      heading: "green",
      firstHeading: "magenta",
      codespan: "black",
      link: "blue",
    },
  },
  ocean: {
    label: "Ocean",
    colors: {
      primary: "blue",
      secondary: "cyan",
      accent: "green",
      info: "cyan",
      muted: "gray",
      success: "cyan",
      warning: "yellow",
      error: "red",
      border: "blue",
    },
    md: {
      code: "blue",
      heading: "cyan",
      firstHeading: "green",
      codespan: "cyan",
      link: "blue",
    },
  },
  sunset: {
    label: "Sunset",
    colors: {
      primary: "magenta",
      secondary: "yellow",
      accent: "red",
      info: "magenta",
      muted: "gray",
      success: "yellow",
      warning: "yellow",
      error: "red",
      border: "magenta",
    },
    md: {
      code: "magenta",
      heading: "yellow",
      firstHeading: "red",
      codespan: "yellow",
      link: "magenta",
    },
  },
  nord: {
    label: "Nord (cool & calm)",
    colors: {
      primary: "cyan",
      secondary: "blue",
      accent: "magenta",
      info: "blue",
      muted: "gray",
      success: "green",
      warning: "yellow",
      error: "red",
      border: "blue",
    },
    md: {
      code: "cyan",
      heading: "blue",
      firstHeading: "magenta",
      codespan: "cyan",
      link: "blue",
    },
  },
  synthwave: {
    label: "Synthwave (neon nights)",
    colors: {
      primary: "magenta",
      secondary: "cyan",
      accent: "yellow",
      info: "cyan",
      muted: "gray",
      success: "green",
      warning: "yellow",
      error: "red",
      border: "magenta",
    },
    md: {
      code: "magenta",
      heading: "cyan",
      firstHeading: "yellow",
      codespan: "cyan",
      link: "magenta",
    },
  },
  mono: {
    label: "Mono (no colors)",
    colors: {
      primary: "white",
      secondary: "white",
      accent: "white",
      info: "white",
      muted: "gray",
      success: "white",
      warning: "white",
      error: "white",
      border: "gray",
    },
    md: {
      code: "white",
      heading: "white",
      firstHeading: "white",
      codespan: "white",
      link: "white",
    },
  },
};

const DEFAULT_THEME_NAME = "dark";

let activeThemeName = DEFAULT_THEME_NAME;

function active() {
  return THEMES[activeThemeName] || THEMES[DEFAULT_THEME_NAME];
}

/**
 * Set the active theme by name. Falls back to the default for unknown names.
 * @param {string} name
 * @returns {string} the theme name actually applied
 */
export function setActiveTheme(name) {
  activeThemeName = THEMES[name] ? name : DEFAULT_THEME_NAME;
  return activeThemeName;
}

export function isValidTheme(name) {
  return Boolean(THEMES[name]);
}

/**
 * Load the configured theme from config and activate it.
 * Call once at CLI startup / before rendering anything styled.
 * @returns {Promise<string>} applied theme name
 */
export async function applyStoredTheme() {
  const cfg = await loadConfig();
  return setActiveTheme(cfg.theme);
}

/**
 * Live theme-aware styling helpers.
 * Always reflect the currently active theme — never cache these references.
 */
export const t = {
  /** Primary brand color (banners, titles, session boxes) */
  primary: (s) => chalk[active().colors.primary](s),
  primaryBold: (s) => chalk[active().colors.primary].bold(s),
  /** Accent color (headings, special callouts) */
  accent: (s) => chalk[active().colors.accent](s),
  accentBold: (s) => chalk[active().colors.accent].bold(s),
  /** Informational text */
  info: (s) => chalk[active().colors.info](s),
  infoBold: (s) => chalk[active().colors.info].bold(s),
  /** Dimmed / helper text */
  muted: (s) => chalk[active().colors.muted](s),
  success: (s) => chalk[active().colors.success](s),
  warning: (s) => chalk[active().colors.warning](s),
  error: (s) => chalk[active().colors.error](s),
  /** Border color value for boxen options */
  border: () => active().colors.border,
  /** Raw chalk color name for a role (for boxen borderColor etc.) */
  color: (role) => active().colors[role] || active().colors.primary,

  /**
   * marked-terminal renderer options for the active theme.
   * Pass to `marked.use(markedTerminal(options))`.
   */
  markdownOptions: () => {    const md = active().md;
    const c = active().colors;
    return {
      code: chalk[md.code],
      blockquote: chalk[c.muted].italic,
      heading: chalk[md.heading].bold,
      firstHeading: chalk[md.firstHeading].underline.bold,
      hr: chalk.reset,
      listitem: chalk.reset,
      list: chalk.reset,
      paragraph: chalk.reset,
      strong: chalk.bold,
      em: chalk.italic,
      codespan: chalk[md.codespan].bgBlack,
      del: chalk.dim.gray.strikethrough,
      link: chalk[md.link].underline,
      href: chalk[md.link].underline,
    };
  },
};

/**
 * Wire themed markdown onto a marked instance: marked-terminal for the active
 * theme, plus a `code` renderer override (marked-terminal's `code` option is
 * only a fallback style) that draws fenced blocks in a rounded box.
 */
export function applyMarkdownTheme(markedInstance: {
  use: (...extensions: any[]) => any;
}) {
  markedInstance.use(markedTerminal(t.markdownOptions()));
  markedInstance.use({
    renderer: {
      code(token: any) {
        const raw =
          token && typeof token === "object" && "text" in token
            ? String(token.text)
            : String(token);
        const lang =
          token && typeof token === "object" && token.lang
            ? String(token.lang).trim()
            : "";
        const color = active().md.code;
        return (
          boxen(chalk[color](raw.replace(/\n+$/, "")), {
            padding: { top: 0, bottom: 0, left: 2, right: 2 },
            margin: { top: 1, bottom: 1, left: 6 },
            borderStyle: "round",
            borderColor: color,
            title: lang ? ` ${lang} ` : undefined,
            titleAlignment: "left",
          }) + "\n\n"
        );
      },
    },
  });
}