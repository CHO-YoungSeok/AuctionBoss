#!/usr/bin/env python3
"""compare-screens.sh가 쓰는 HTML 정규화기. 표준 입력 -> 표준 출력.

두 Next 인스턴스는 같은 빌드를 쓰지만, 데이터가 SQLite에서 동기로 오느냐 Spring에서 비동기로 오느냐에 따라 React의
스트리밍 "조각 나누기"와 조각 번호가 달라진다(내용은 같다). 그 부분만 정규화한다.
  N1. `/_next/static/<빌드ID>/` -> `BUILD`.
  N2. `self.__next_f.push([1,"..."])` 스트리밍 조각(RSC flight 데이터)은 이어 붙여 해석한 뒤, 줄 앞의 조각 번호(`4:`),
      참조 번호(`$L10`, `$S...`)를 지우고 줄을 정렬한다. 조각 순서와 번호만 무시하고 값(문자열·속성·숫자)은 그대로 비교한다.
  N3. `$RC`/`$RS` 등 Suspense 완료 인라인 스크립트와 `<div hidden id="S:n">`, `B:n`/`S:n` 번호는 번호만 `#`으로 바꾼다.
화면에 보이는 DOM(조각이 아닌 부분)은 아무것도 바꾸지 않는다.
"""
import json
import re
import sys

html = sys.stdin.read()
html = re.sub(r"/_next/static/[A-Za-z0-9_-]{16,}/", "/_next/static/BUILD/", html)

PUSH = re.compile(r'<script>self\.__next_f\.push\(\[(\d+),("(?:[^"\\]|\\.)*")\]\)</script>')
payload = []


def grab(m):
    payload.append(json.loads(m.group(2)))
    return "<!--FLIGHT-->"


html = PUSH.sub(grab, html)
# 연속된 자리표시자는 하나로(조각 수가 달라도 같게)
html = re.sub(r"(?:<!--FLIGHT-->\s*)+", "<!--FLIGHT-->", html)
html = re.sub(r'id="([BS]):\d+"', r'id="\1:#"', html)
html = re.sub(r'\$R([CSBX])\(\"([BS]):\d+\",\"([BS]):\d+\"\)', r'$R\1("#","#")', html)
html = re.sub(r'<template id="([BS]):\d+"', r'<template id="\1:#"', html)

flight = "".join(payload)
lines = []
for line in flight.split("\n"):
    line = re.sub(r"^[0-9a-f]+:", "", line)
    line = re.sub(r"\$L[0-9a-f]+", "$L", line)
    line = re.sub(r"\$[BS][0-9a-f]*", "$X", line)
    line = re.sub(r"\"(\d+)\"", '"#"', line) if False else line
    if line:
        lines.append(line)
lines.sort()
sys.stdout.write(html)
sys.stdout.write("\n<!--FLIGHT-LINES-->\n" + "\n".join(lines) + "\n")
