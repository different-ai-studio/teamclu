// File icon mapping tables — extracted from FileTree.tsx
// Pure data + lookup function, no React component dependencies

import {
  File,
  FileCode,
  FileJson,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  FileSpreadsheet,
  Settings,
  Database,
  Terminal,
  Globe,
  Lock,
  Key,
  type LucideIcon,
} from "lucide-react";

type IconEntry = { icon: LucideIcon; color: string };

const SPECIAL_FILE_ICONS: Record<string, IconEntry> = {
  "package.json": { icon: FileJson, color: "text-green-500" },
  "package-lock.json": { icon: FileJson, color: "text-green-500" },
  "tsconfig.json": { icon: Settings, color: "text-blue-500" },
  "jsconfig.json": { icon: Settings, color: "text-blue-500" },
  ".gitignore": { icon: File, color: "text-gray-500" },
  ".dockerignore": { icon: File, color: "text-gray-500" },
  "dockerfile": { icon: Database, color: "text-blue-400" },
  "license": { icon: FileText, color: "text-gray-500" },
  "license.md": { icon: FileText, color: "text-gray-500" },
  "license.txt": { icon: FileText, color: "text-gray-500" },
  "readme.md": { icon: FileText, color: "text-blue-400" },
  "readme": { icon: FileText, color: "text-blue-400" },
};

const EXT_ICONS: Record<string, IconEntry> = {
  // TypeScript/JavaScript
  ts: { icon: FileCode, color: "text-blue-500" },
  tsx: { icon: FileCode, color: "text-blue-500" },
  js: { icon: FileCode, color: "text-yellow-500" },
  jsx: { icon: FileCode, color: "text-yellow-500" },
  mjs: { icon: FileCode, color: "text-yellow-500" },
  cjs: { icon: FileCode, color: "text-yellow-500" },
  // Web
  html: { icon: Globe, color: "text-orange-500" },
  htm: { icon: Globe, color: "text-orange-500" },
  css: { icon: FileCode, color: "text-pink-500" },
  scss: { icon: FileCode, color: "text-pink-500" },
  sass: { icon: FileCode, color: "text-pink-500" },
  less: { icon: FileCode, color: "text-pink-500" },
  vue: { icon: FileCode, color: "text-green-500" },
  svelte: { icon: FileCode, color: "text-orange-600" },
  // Data
  json: { icon: FileJson, color: "text-yellow-500" },
  jsonc: { icon: FileJson, color: "text-yellow-500" },
  yaml: { icon: FileJson, color: "text-purple-500" },
  yml: { icon: FileJson, color: "text-purple-500" },
  toml: { icon: FileJson, color: "text-gray-600" },
  xml: { icon: FileCode, color: "text-orange-400" },
  csv: { icon: FileSpreadsheet, color: "text-green-600" },
  sql: { icon: Database, color: "text-blue-400" },
  // Documentation
  md: { icon: FileText, color: "text-blue-400" },
  mdx: { icon: FileText, color: "text-blue-400" },
  txt: { icon: FileText, color: "text-gray-500" },
  pdf: { icon: FileText, color: "text-red-500" },
  doc: { icon: FileText, color: "text-blue-600" },
  docx: { icon: FileText, color: "text-blue-600" },
  // Images
  png: { icon: FileImage, color: "text-purple-500" },
  jpg: { icon: FileImage, color: "text-purple-500" },
  jpeg: { icon: FileImage, color: "text-purple-500" },
  gif: { icon: FileImage, color: "text-purple-500" },
  webp: { icon: FileImage, color: "text-purple-500" },
  svg: { icon: FileImage, color: "text-purple-500" },
  ico: { icon: FileImage, color: "text-purple-500" },
  bmp: { icon: FileImage, color: "text-purple-500" },
  // Video
  mp4: { icon: FileVideo, color: "text-pink-500" },
  webm: { icon: FileVideo, color: "text-pink-500" },
  mov: { icon: FileVideo, color: "text-pink-500" },
  avi: { icon: FileVideo, color: "text-pink-500" },
  mkv: { icon: FileVideo, color: "text-pink-500" },
  // Audio
  mp3: { icon: FileAudio, color: "text-green-500" },
  wav: { icon: FileAudio, color: "text-green-500" },
  ogg: { icon: FileAudio, color: "text-green-500" },
  flac: { icon: FileAudio, color: "text-green-500" },
  m4a: { icon: FileAudio, color: "text-green-500" },
  // Archives
  zip: { icon: FileArchive, color: "text-amber-600" },
  tar: { icon: FileArchive, color: "text-amber-600" },
  gz: { icon: FileArchive, color: "text-amber-600" },
  rar: { icon: FileArchive, color: "text-amber-600" },
  "7z": { icon: FileArchive, color: "text-amber-600" },
  // Programming languages
  py: { icon: FileCode, color: "text-yellow-500" },
  rb: { icon: FileCode, color: "text-red-500" },
  go: { icon: FileCode, color: "text-cyan-500" },
  rs: { icon: FileCode, color: "text-orange-600" },
  java: { icon: FileCode, color: "text-red-400" },
  kt: { icon: FileCode, color: "text-purple-500" },
  kts: { icon: FileCode, color: "text-purple-500" },
  swift: { icon: FileCode, color: "text-orange-500" },
  c: { icon: FileCode, color: "text-blue-400" },
  h: { icon: FileCode, color: "text-blue-400" },
  cpp: { icon: FileCode, color: "text-blue-500" },
  cc: { icon: FileCode, color: "text-blue-500" },
  hpp: { icon: FileCode, color: "text-blue-500" },
  cs: { icon: FileCode, color: "text-green-600" },
  php: { icon: FileCode, color: "text-indigo-400" },
  lua: { icon: FileCode, color: "text-blue-400" },
  // Shell/Scripts
  sh: { icon: Terminal, color: "text-gray-500" },
  bash: { icon: Terminal, color: "text-gray-500" },
  zsh: { icon: Terminal, color: "text-gray-500" },
  fish: { icon: Terminal, color: "text-gray-500" },
  ps1: { icon: Terminal, color: "text-blue-400" },
  bat: { icon: Terminal, color: "text-blue-400" },
  cmd: { icon: Terminal, color: "text-blue-400" },
  // Config
  ini: { icon: Settings, color: "text-gray-500" },
  cfg: { icon: Settings, color: "text-gray-500" },
  conf: { icon: Settings, color: "text-gray-500" },
  env: { icon: Key, color: "text-yellow-600" },
  // Lock files
  lock: { icon: Lock, color: "text-gray-400" },
};

const DEFAULT_FILE_ICON: IconEntry = { icon: File, color: "text-muted-foreground" };

// Get file icon and color based on file extension — O(1) lookup
export function getFileIcon(filename: string): IconEntry {
  const name = filename.toLowerCase();

  // Check special filenames first (exact match)
  const special = SPECIAL_FILE_ICONS[name];
  if (special) return special;

  // Prefix matches for docker-compose and .env variants
  if (name.startsWith("docker-compose")) return { icon: Database, color: "text-blue-400" };
  if (name === ".env" || name.startsWith(".env.")) return { icon: Key, color: "text-yellow-600" };

  // Extension lookup
  const ext = name.split(".").pop() || "";
  return EXT_ICONS[ext] || DEFAULT_FILE_ICON;
}
