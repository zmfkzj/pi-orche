import { debounce } from './rate.js';

export function createSearchBox(api) {
  const search = debounce(query => api.search(query), 300);
  return { onInput: text => search(text) };
}
