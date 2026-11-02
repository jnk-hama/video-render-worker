#!/bin/bash
# stage/fonts を作る（Google Fonts の Dela Gothic One / Noto Sans JP を手元に落として、CSS の参照先を書き換える）
mkdir -p stage/fonts && cd stage/fonts
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=Noto+Sans+JP:wght@500;700;900&display=block" -o fonts.css
for u in $(grep -oE 'https://fonts.gstatic.com[^)]+' fonts.css | sort -u); do
  f=$(echo "$u" | md5sum | cut -c1-12).woff2; curl -s -o "$f" "$u"; sed -i "s#$u#$f#g" fonts.css
done
