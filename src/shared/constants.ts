/** 共享常量（00 文档 §4：shared = 常量、类型） */

/** 设置存储 Key（07 文档 §3，与原版 shared_preferences key 原样保留） */
export const SETTING_KEYS = {
  globalAutoSave: 'global_auto_save',
  corpusUserPath: 'corpus.userPath'
} as const

/** 主题与棋盘调色板（对齐 lib/shared/constants.dart AppColors，08 文档 §1） */
export const APP_COLORS = {
  /** 主题种子色（Material 3 棕色系） */
  seed: '#8D6E63',
  /** 棋盘木色 */
  boardBackground: '#F3D9A6',
  /** 棋盘线条（深棕） */
  boardLine: '#8A6A3F',
  riverText: '#8A6A3F',
  pieceRed: '#B71C1C',
  pieceBlack: '#212121',
  /** 棋子盘面（红黑共用） */
  pieceFace: '#FBEFD0',
  selected: 'rgba(21, 101, 192, 0.416)', // 0x6A1565C0
  legalHint: 'rgba(46, 125, 50, 0.416)', // 0x6A2E7D32
  lastMove: 'rgba(249, 168, 37, 0.333)' // 0x55F9A825
} as const

/** 字体栈（08 文档 §1） */
export const FONT_STACK = "'Microsoft YaHei', 'PingFang SC', serif" as const

/** 语料包下载地址（corpus_paths.dart:34-35，GitHub Release 附件，永远指向最新一版） */
export const CORPUS_DOWNLOAD_URL =
  'https://github.com/jxsword/qp-corpus/releases/latest/download/qp-corpus.zip'
