/** The first letter of a name, in capitals (an emoji counts as one), for a tile that has no picture. */
export const initial = (name: string, fallback = '♪'): string => Array.from(name.trim())[0]?.toUpperCase() ?? fallback;
