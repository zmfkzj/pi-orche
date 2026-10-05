/** players arrive in signup order. */
export function rank(players) {
  return [...players].sort((a, b) => b.score - a.score);
}
