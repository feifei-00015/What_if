// GitHub Pages 发布时填入云端 API 的 HTTPS Origin，例如 https://api.example.com；本机留空。
export const API_ORIGIN = '';

export function apiUrl(path, origin = API_ORIGIN) {
  return origin ? `${origin.replace(/\/$/, '')}${path}` : path;
}
