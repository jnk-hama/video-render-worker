import { Config } from "@remotion/cli/config";

/*
 * ★描画時間がそのまま「1日に出せる本数」になる（Actions 無料枠2,000分/月）。
 *   画質より先に、時間の効く設定を固定する。
 */
Config.setVideoImageFormat("jpeg");   // pngは無劣化だが書き出しが遅い
Config.setJpegQuality(90);
Config.setCodec("h264");
Config.setCrf(23);                    // ffmpeg版と同じ。比較できるように揃える
Config.setChromiumOpenGlRenderer("angle-egl");
Config.setOverwriteOutput(true);
