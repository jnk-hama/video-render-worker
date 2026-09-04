# 効果音（自前生成・第三者の権利なし）

台本の `fx` タグ（fire / neon / pop / shock / clean）と同じ名前で置く。
描画側は `job.sfx = [{"tag": "pop", "at_ratio": 0.35}]` で受け取り、
`at_ratio`（全体の尺に対する割合）か `at`（秒）で位置を決める。

## なぜ音源サイトから落とさないか

配布元が消えれば描画が止まり、ライセンスの確認も毎回発生する。
ffmpeg の合成音なら**最初から第三者の権利が無い**。
音量はピークを **-6dB** へ揃えてあるので、`SFX_VOLUME` の倍率だけで
狙った大きさになる。

## 作り直す時のコマンド

```bash
cd assets/sfx
ffmpeg -y -f lavfi -i "sine=frequency=900:duration=0.14,volume=0.9,afade=t=out:st=0.03:d=0.11,asetrate=44100*1.6,aresample=44100" -c:a libmp3lame -q:a 4 pop.mp3
ffmpeg -y -f lavfi -i "sine=frequency=420:duration=0.40" -af "asetrate=44100,volume=0.8,aeval=val(0)*sin(2*PI*t*t*900)|val(0)*sin(2*PI*t*t*900),afade=t=out:st=0.18:d=0.22" -c:a libmp3lame -q:a 4 neon.mp3
ffmpeg -y -f lavfi -i "sine=frequency=110:duration=0.35" -af "volume=1.0,afade=t=out:st=0.05:d=0.30" -c:a libmp3lame -q:a 4 fire.mp3
ffmpeg -y -f lavfi -i "anoisesrc=d=0.45:c=pink:a=0.6" -af "highpass=f=600,lowpass=f=5000,afade=t=in:st=0:d=0.05,afade=t=out:st=0.12:d=0.33" -c:a libmp3lame -q:a 4 shock.mp3
ffmpeg -y -f lavfi -i "sine=frequency=1320:duration=0.6" -af "volume=0.55,afade=t=out:st=0.05:d=0.55" -c:a libmp3lame -q:a 4 clean.mp3

# ピークを -6dB へ揃える
for f in *.mp3; do
  peak=$(ffmpeg -hide_banner -i "$f" -af volumedetect -f null - 2>&1 | grep max_volume | sed 's/.*max_volume: //;s/ dB//')
  gain=$(python3 -c "print(round(-6.0 - ($peak), 2))")
  ffmpeg -y -i "$f" -af "volume=${gain}dB" -c:a libmp3lame -q:a 4 "n_$f" && mv "n_$f" "$f"
done
```

| タグ | 音 | 用途 |
|---|---|---|
| `pop` | 短い高音のポップ | 日用品系・軽い切り替え |
| `neon` | 上昇するスイープ | ガジェット系 |
| `fire` | 低い衝撃音 | 衝撃・情熱系 |
| `shock` | ノイズのヒット | 警告・問題提起 |
| `clean` | ベル系の余韻 | 美容系・締め |
