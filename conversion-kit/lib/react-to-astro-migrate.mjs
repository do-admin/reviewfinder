/**
 * Shared mechanical helpers for React (Vite/Lovable) → Astro migration.
 * Used by migrate-lovable-to-scaffold.mjs (conversion-kit).
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

export function needsClientDirective(content) {
  const clientIndicators = [
    /\buseState\b/,
    /\buseEffect\b/,
    /\buseRef\b/,
    /\buseCallback\b/,
    /\buseMemo\b/,
    /\buseReducer\b/,
    /\buseContext\b/,
    /\bonClick\b/,
    /\bonChange\b/,
    /\bonSubmit\b/,
    /\bonFocus\b/,
    /\bonBlur\b/,
    /\bonKeyDown\b/,
    /\bonKeyUp\b/,
    /\bonMouseEnter\b/,
    /\bonMouseLeave\b/,
    /\bwindow\.\b/,
    /\bdocument\.\b/,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bnavigator\b/,
    /\bsetInterval\b/,
    /\bsetTimeout\b/,
  ];
  return clientIndicators.some((re) => re.test(content));
}

export function convertAssetImports(content) {
  const assetImportRegex =
    /import\s+(\w+)\s+from\s+['"]@\/assets\/([^'"]+)['"];?\s*\n?/g;
  const assetMappings = {};
  content = content.replace(
    assetImportRegex,
    (match, importName, assetPath) => {
      assetMappings[importName] = assetPath;
      return '';
    }
  );
  Object.entries(assetMappings).forEach(([importName, assetPath]) => {
    content = content.replace(
      new RegExp(`src=\\{${importName}\\}`, 'g'),
      `src="/assets/${assetPath}"`
    );
    content = content.replace(
      new RegExp(`(?<!\\w)\\{${importName}\\}(?!\\w)`, 'g'),
      `"/assets/${assetPath}"`
    );
  });
  return content;
}

export function convertReactRouterLinks(content) {
  content = content.replace(
    /import\s+\{[^}]*\}\s+from\s+['"]react-router-dom['"];?\s*\n?/g,
    ''
  );
  content = content.replace(
    /import\s+.*?\s+from\s+['"]react-router-dom['"];?\s*\n?/g,
    ''
  );
  content = content.replace(
    /<Link\s+([\s\S]*?)to\s*=\s*(\{[^}]+\}|["'][^"']*["'])([\s\S]*?)>/g,
    (match, beforeTo, toValue, afterTo) => {
      const allAttributes = (beforeTo + ' ' + afterTo).trim();
      const cleanAttributes = allAttributes
        .replace(/\s+/g, ' ')
        .replace(/^\s+|\s+$/g, '');
      const formattedHref = toValue;
      if (cleanAttributes) {
        return `<a href=${formattedHref} ${cleanAttributes}>`;
      }
      return `<a href=${formattedHref}>`;
    }
  );
  content = content.replace(/<\/Link>/g, '</a>');
  content = content.replace(
    /const\s+navigate\s*=\s*useNavigate\(\);?\s*\n?/g,
    ''
  );
  content = content.replace(
    /navigate\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    'window.location.href = "$1"'
  );
  return content;
}

export function removeNextImports(content) {
  content = content.replace(
    /import\s+Image\s+from\s+['"]next\/image['"];?\s*\n?/g,
    ''
  );
  content = content.replace(
    /import\s+Link\s+from\s+['"]next\/link['"];?\s*\n?/g,
    ''
  );
  content = content.replace(
    /import\s+\{[^}]*\}\s+from\s+['"]next\/navigation['"];?\s*\n?/g,
    ''
  );
  content = content.replace(
    /import\s+\{[^}]*\}\s+from\s+['"]next\/router['"];?\s*\n?/g,
    ''
  );
  content = content.replace(/<Image\b/g, '<img');
  content = content.replace(/<\/Image>/g, '</img>');
  content = content.replace(
    /<Link\s+([\s\S]*?)href\s*=\s*(\{[^}]+\}|["'][^"']*["'])([\s\S]*?)>/g,
    (match, beforeHref, href, afterHref) => {
      const allAttributes = (beforeHref + ' ' + afterHref).trim();
      const cleanAttributes = allAttributes
        .replace(/\s+/g, ' ')
        .replace(/^\s+|\s+$/g, '');
      if (cleanAttributes) {
        return `<a href=${href} ${cleanAttributes}>`;
      }
      return `<a href=${href}>`;
    }
  );
  content = content.replace(/<\/Link>/g, '</a>');
  return content;
}

export function convertWindowLocationButtons(content) {
  content = content.replace(
    /<Button([^>]*?)onClick=\{\(\) => window\.location\.href\s*=\s*"([^"]+)"\}([^>]*?)>([\s\S]*?)<\/Button>/g,
    (match, buttonProps, href, remainingProps, buttonContent) => {
      const classNameMatch = (buttonProps + remainingProps).match(
        /className="([^"]+)"/
      );
      let linkProps = `href="${href}"`;
      if (classNameMatch) {
        linkProps += ` class="${classNameMatch[1]}"`;
      }
      return `<a ${linkProps}>${buttonContent}</a>`;
    }
  );
  content = content.replace(
    /onClick=\{\(\) => window\.location\.href\s*=\s*"([^"]+)"\}/g,
    ''
  );
  return content;
}

export function processComponentFile(content) {
  content = convertReactRouterLinks(content);
  content = removeNextImports(content);
  content = convertAssetImports(content);
  content = convertWindowLocationButtons(content);
  return content;
}

// ---------------------------------------------------------------------------
// Page discovery
// ---------------------------------------------------------------------------

/**
 * @param {string} pagesDirAbs absolute path to React src/pages
 */
export function discoverReactPages(pagesDirAbs) {
  if (!fs.existsSync(pagesDirAbs)) return [];

  const pages = [];
  const items = fs.readdirSync(pagesDirAbs);

  items.forEach((item) => {
    const fullPath = path.join(pagesDirAbs, item);
    const stat = fs.statSync(fullPath);

    if (stat.isFile() && (item.endsWith('.tsx') || item.endsWith('.jsx'))) {
      const name = path.basename(item, path.extname(item));
      pages.push({ name, filePath: fullPath, isSubDir: false });
    }

    if (stat.isDirectory()) {
      const subFiles = fs.readdirSync(fullPath);
      subFiles.forEach((sf) => {
        if (sf.endsWith('.tsx') || sf.endsWith('.jsx')) {
          const name = path.basename(sf, path.extname(sf));
          pages.push({
            name,
            filePath: path.join(fullPath, sf),
            isSubDir: true,
            subDir: item,
          });
        }
      });
    }
  });

  return pages;
}

// ---------------------------------------------------------------------------
// Astro page shell (BaseLayout + island)
// ---------------------------------------------------------------------------

export function createAstroPageForReactComponent(
  componentName,
  routeSlug,
  targetDirAbs,
  opts = {}
) {
  const { isIndex = false, componentContent = '' } = opts;

  const isClient = componentContent ? needsClientDirective(componentContent) : true;
  const clientDirective = isClient ? ' client:load' : '';

  const componentImportPath = `@/components/pages/${componentName}`;
  const pageName = isIndex ? 'home' : routeSlug;

  const astroPage = `---
import BaseLayout from '@/layouts/BaseLayout.astro';
import ${componentName} from '${componentImportPath}';
import { SUPPORTED_LANGUAGES } from '@/lib/language';
import { loadPageContext } from '@/lib/page-data';
import type { SupportedLanguage } from '@/lib/language';

export function getStaticPaths() {
  return SUPPORTED_LANGUAGES.map((lang) => ({ params: { lang } }));
}

const { lang } = await Astro.params;
const language = lang as SupportedLanguage;
const preferredId = import.meta.env.SITE_ID || '';
const ctx = loadPageContext(preferredId, language, {
  pageName: '${pageName}',
  pathSuffix: '${isIndex ? '' : `/${routeSlug}`}',
});

if (!ctx) {
  return Astro.redirect('/404');
}

const { pageData, clientDomain, srcPath, languageConfig, alternates } = ctx;
const meta = pageData.metadata || {};
---

<BaseLayout
  title={meta.title || '${componentName}'}
  description={meta.description || ''}
  canonical={meta.canonical}
  lang={language}
  dir={languageConfig?.direction || 'ltr'}
  openGraph={meta.openGraph}
  twitter={meta.twitter}
  alternates={alternates}
  schema={meta.schema}
  siteUrl={clientDomain}
>
  <${componentName}${clientDirective} />
</BaseLayout>
`;

  const fileName = isIndex ? 'index.astro' : `${routeSlug}.astro`;
  const outPath = path.join(targetDirAbs, fileName);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, astroPage, 'utf-8');
}

/**
 * Dynamic segment under [lang], e.g. ratgeber/[slug].astro
 * Uses a placeholder slug so static build succeeds; AI migration should replace with real paths.
 */
export function createDynamicAstroLangPage({
  componentName,
  targetDirAbs,
  paramName,
  pageNameForContext,
  /** URL segment, e.g. "ratgeber" → \`/ratgeber/${paramName}\` */
  pathSegment,
  componentContent,
}) {
  const isClient = componentContent ? needsClientDirective(componentContent) : true;
  const clientDirective = isClient ? ' client:load' : '';

  const componentImportPath = `@/components/pages/${componentName}`;

  const astroPage = `---
import BaseLayout from '@/layouts/BaseLayout.astro';
import ${componentName} from '${componentImportPath}';
import { SUPPORTED_LANGUAGES } from '@/lib/language';
import { loadPageContext } from '@/lib/page-data';
import type { SupportedLanguage } from '@/lib/language';

export function getStaticPaths() {
  return SUPPORTED_LANGUAGES.map((lang) => ({
    params: { lang, ${paramName}: 'placeholder' },
  }));
}

const { lang, ${paramName} } = Astro.params;
const language = lang as SupportedLanguage;
const preferredId = import.meta.env.SITE_ID || '';
const ctx = loadPageContext(preferredId, language, {
  pageName: '${pageNameForContext}',
  pathSuffix: \`/${pathSegment}/\${${paramName}}\`,
});

if (!ctx) {
  return Astro.redirect('/404');
}

const { pageData, clientDomain, srcPath, languageConfig, alternates } = ctx;
const meta = pageData.metadata || {};
---

<BaseLayout
  title={meta.title || '${componentName}'}
  description={meta.description || ''}
  canonical={meta.canonical}
  lang={language}
  dir={languageConfig?.direction || 'ltr'}
  openGraph={meta.openGraph}
  twitter={meta.twitter}
  alternates={alternates}
  schema={meta.schema}
  siteUrl={clientDomain}
>
  <${componentName}${clientDirective} />
</BaseLayout>
`;

  fs.mkdirSync(targetDirAbs, { recursive: true });
  const fileName = `[${paramName}].astro`;
  fs.writeFileSync(path.join(targetDirAbs, fileName), astroPage, 'utf-8');
}

export const DEFAULT_ROUTE_MAPPINGS = {
  Index: { slug: 'index', isIndex: true },
  UeberUns: { slug: 'ueber-uns' },
  Leistungen: { slug: 'leistungen' },
  Impressum: { slug: 'impressum' },
  Datenschutz: { slug: 'datenschutz' },
  Kontakt: { slug: 'kontakt' },
  NotFound: null,
};

/** Route slugs for typical Lovable directory sites (extend as needed). */
export const LOVABLE_KITA_ROUTE_MAPPINGS = {
  ...DEFAULT_ROUTE_MAPPINGS,
  FAQ: { slug: 'faq' },
  Lexikon: { slug: 'lexikon' },
  Ratgeber: { slug: 'ratgeber' },
  KitaHinzufuegen: { slug: 'kita-hinzufuegen' },
  Barrierefreiheit: { slug: 'barrierefreiheit' },
  UeberDasProjekt: { slug: 'ueber-das-projekt' },
  PremiumPartner: { slug: 'premium-partner' },
  Nutzungsbedingungen: { slug: 'nutzungsbedingungen' },
  Kooperationspartner: { slug: 'kooperationspartner' },
  Top10: { slug: 'top-10' },
  KategoriePage: { slug: 'kategorie-page' },
  StadtteilPage: { slug: 'stadtteil' },
  NotFound: null,
  /** Handled separately — dynamic */
  RatgeberArticle: null,
  KitaDetail: null,
};

export function writeRootRedirectIndex(astroAppDir) {
  const rootIndex = `---
import { DEFAULT_LANGUAGE } from '@/lib/language';
---

<!doctype html>
<html lang={DEFAULT_LANGUAGE}>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="refresh" content={\`0;url=/\${DEFAULT_LANGUAGE}\`} />
    <link rel="canonical" href={\`/\${DEFAULT_LANGUAGE}\`} />
    <title>Redirect</title>
  </head>
  <body>
    <p>Redirecting to <a href={\`/\${DEFAULT_LANGUAGE}\`}>/{DEFAULT_LANGUAGE}</a>…</p>
    <script is:inline define:vars={{ DEFAULT_LANGUAGE }}>
      window.location.replace('/' + DEFAULT_LANGUAGE);
    </script>
  </body>
</html>
`;
  const p = path.join(astroAppDir, 'src/pages/index.astro');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, rootIndex, 'utf-8');
}

/**
 * Copy React page components into dest/src/components/pages and emit [lang]/*.astro routes.
 */
export function createPagesFromReactPages({
  astroAppDir,
  pagesSourceDirAbs,
  routeMappings = LOVABLE_KITA_ROUTE_MAPPINGS,
  log = console.log,
  writeRootIndex = true,
}) {
  log('📄 Creating Astro pages from React pages...', 'blue');

  const pages = discoverReactPages(pagesSourceDirAbs);
  if (pages.length === 0) {
    log('⚠️  No React pages found. Skipping page creation.', 'yellow');
    return;
  }

  const langPagesDir = path.join(astroAppDir, 'src/pages/[lang]');
  fs.mkdirSync(langPagesDir, { recursive: true });

  const pagesComponentDir = path.join(astroAppDir, 'src/components/pages');
  fs.mkdirSync(pagesComponentDir, { recursive: true });

  pages.forEach(({ name, filePath, isSubDir, subDir }) => {
    if (name === 'NotFound') {
      log('⏭️  Skipping NotFound (handled separately)', 'yellow');
      return;
    }

    if (name === 'RatgeberArticle') {
      let content = fs.readFileSync(filePath, 'utf-8');
      content = processComponentFile(content);
      fs.writeFileSync(
        path.join(pagesComponentDir, `RatgeberArticle${path.extname(filePath)}`),
        content,
        'utf-8'
      );
      const ratgeberDir = path.join(langPagesDir, 'ratgeber');
      createDynamicAstroLangPage({
        componentName: 'RatgeberArticle',
        targetDirAbs: ratgeberDir,
        paramName: 'slug',
        pageNameForContext: 'ratgeber-article',
        pathSegment: 'ratgeber',
        componentContent: content,
      });
      log('✅ Created dynamic /ratgeber/[slug] page', 'green');
      return;
    }

    if (name === 'KitaDetail') {
      let content = fs.readFileSync(filePath, 'utf-8');
      content = processComponentFile(content);
      fs.writeFileSync(
        path.join(pagesComponentDir, `KitaDetail${path.extname(filePath)}`),
        content,
        'utf-8'
      );
      const kitaDir = path.join(langPagesDir, 'kita');
      createDynamicAstroLangPage({
        componentName: 'KitaDetail',
        targetDirAbs: kitaDir,
        paramName: 'slug',
        pageNameForContext: 'kita-detail',
        pathSegment: 'kita',
        componentContent: content,
      });
      log('✅ Created dynamic /kita/[slug] page', 'green');
      return;
    }

    let content = fs.readFileSync(filePath, 'utf-8');
    content = processComponentFile(content);

    const ext = path.extname(filePath);
    const componentFile = `${name}${ext}`;

    if (isSubDir) {
      const subComponentDir = path.join(pagesComponentDir, subDir);
      fs.mkdirSync(subComponentDir, { recursive: true });
      fs.writeFileSync(path.join(subComponentDir, componentFile), content, 'utf-8');
    } else {
      fs.writeFileSync(path.join(pagesComponentDir, componentFile), content, 'utf-8');
    }

    const mapping = routeMappings[name];
    let routeSlug;
    let isIndex = false;

    if (mapping === null) return;

    if (mapping) {
      routeSlug = mapping.slug;
      isIndex = !!mapping.isIndex;
    } else {
      routeSlug = name
        .replace(/([A-Z])/g, '-$1')
        .toLowerCase()
        .replace(/^-/, '');
    }

    if (isSubDir) {
      const subPagesDir = path.join(langPagesDir, subDir);
      fs.mkdirSync(subPagesDir, { recursive: true });
      createAstroPageForReactComponent(name, routeSlug, subPagesDir, {
        isIndex,
        componentContent: content,
      });
      log(`✅ Created /${subDir}/${isIndex ? '' : routeSlug} page`, 'green');
    } else if (isIndex) {
      createAstroPageForReactComponent(name, routeSlug, langPagesDir, {
        isIndex: true,
        componentContent: content,
      });
      log('✅ Created homepage (index) page', 'green');
    } else {
      createAstroPageForReactComponent(name, routeSlug, langPagesDir, {
        componentContent: content,
      });
      log(`✅ Created /${routeSlug} page`, 'green');
    }
  });

  if (writeRootIndex) {
    writeRootRedirectIndex(astroAppDir);
    log('✅ Root redirect index.astro written', 'green');
  }
}

/**
 * Merge Lovable/Vite `src/components` into Astro project (processed TS/JS).
 */
export function mergeComponentsFromSrcRepo(srcRepoAbs, astroAppDir, log = console.log) {
  const source = path.join(srcRepoAbs, 'src/components');
  const target = path.join(astroAppDir, 'src/components');
  if (!fs.existsSync(source)) {
    log('⚠️  No src/components in source repo. Skipping.', 'yellow');
    return;
  }

  function copyRecursive(src, tgt) {
    fs.mkdirSync(tgt, { recursive: true });
    for (const item of fs.readdirSync(src)) {
      const sp = path.join(src, item);
      const tp = path.join(tgt, item);
      const st = fs.statSync(sp);
      if (st.isDirectory()) {
        copyRecursive(sp, tp);
      } else {
        const isCode =
          item.endsWith('.tsx') ||
          item.endsWith('.ts') ||
          item.endsWith('.jsx') ||
          item.endsWith('.js');
        if (isCode) {
          let c = fs.readFileSync(sp, 'utf-8');
          c = processComponentFile(c);
          fs.writeFileSync(tp, c, 'utf-8');
        } else {
          fs.copyFileSync(sp, tp);
        }
      }
    }
  }

  copyRecursive(source, target);
  log('✅ Merged src/components from source repo', 'green');
}

/**
 * Copy public + assets from Lovable repo into Astro project.
 */
export function mergePublicAndAssetsFromSrcRepo(srcRepoAbs, astroAppDir, log = console.log) {
  const pub = path.join(srcRepoAbs, 'public');
  const destPub = path.join(astroAppDir, 'public');
  if (fs.existsSync(pub)) {
    fs.cpSync(pub, destPub, { recursive: true });
    log('✅ Copied public/', 'green');
  }
  const assets = path.join(srcRepoAbs, 'src/assets');
  const destAssets = path.join(astroAppDir, 'src/assets');
  if (fs.existsSync(assets)) {
    fs.mkdirSync(destAssets, { recursive: true });
    fs.cpSync(assets, destAssets, { recursive: true });
    log('✅ Copied src/assets/', 'green');
  }
}
