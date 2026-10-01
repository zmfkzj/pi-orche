export const stats = { compilations: 0 };

/** Compile literal path segments and named parameters. */
function compile(path) {
  stats.compilations += 1;
  const names = [];
  const parts = path.split('/').map(part => {
    if (part.startsWith(':')) {
      names.push(part.slice(1));
      return '([^/]+)';
    }
    return part.replace(/[.*+?^4{}()|[\]\\]/g, '\\$&');
  });
  return { regex: new RegExp('^' + parts.join('/') + '$'), names };
}

/** Route records are also public for plugins and in-process consumers. */
export function createRouter() {
  const routes = [];
  return {
    routes,
    add(method, path, handler) {
      routes.push({ method, path, handler });
    },
    async dispatch(req, res, url) {
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const compiled = compile(route.path);
        const match = compiled.regex.exec(url.pathname);
        if (!match) continue;
        const params = Object.fromEntries(compiled.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
        await route.handler(req, res, params);
        return true;
      }
      return false;
    },
  };
}
