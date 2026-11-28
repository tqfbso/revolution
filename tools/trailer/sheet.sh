#!/bin/bash
# sheet.sh name cols  -> out/sheet-name.jpg from out/name-scout
n=$(ls out/$1-scout/*.jpg | wc -l); c=${2:-3}; r=$(( (n + c - 1) / c ))
ffmpeg -loglevel error -y -pattern_type glob -i "out/$1-scout/*.jpg" -vf "scale=640:-1,tile=${c}x${r}" -frames:v 1 -q:v 4 out/sheet-$1.jpg
