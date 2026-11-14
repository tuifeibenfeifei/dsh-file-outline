"""Write realistic-length samples (a few paragraphs) in each legacy encoding."""
import sys
from pathlib import Path

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

SJIS = (
    "# テスト用ドキュメント\n\n"
    "このファイルは日本語で書かれた文書です。文字コードの判定を確認するために、"
    "ある程度の長さの本文を用意しました。日本語の文章には、ひらがな、カタカナ、"
    "そして漢字が混在します。正しい判定ができていれば、これらの文字が正しく読めます。\n\n"
    "## 見出しの例\n\n"
    "本文の段落が続きます。文字化けが起きていないかを確認してください。\n"
)

EUCKR = (
    "# 한국어 문서\n\n"
    "이 파일은 한국어로 작성된 문서입니다. 인코딩 판별을 확인하기 위해 "
    "충분한 길이의 본문을 준비했습니다. 한국어 문장은 한글 음절로 구성됩니다. "
    "올바르게 판별되었다면 이 글자들이 정상적으로 보일 것입니다.\n\n"
    "## 제목 예시\n\n"
    "본문 단락이 이어집니다. 글자가 깨지지 않았는지 확인하십시오.\n"
)

CP1251 = (
    "# Русский документ\n\n"
    "Этот файл написан на русском языке. Чтобы проверить определение кодировки, "
    "мы подготовили текст достаточной длины. Русский текст состоит из кириллических "
    "букв, и при верном определении все они читаются правильно.\n\n"
    "## Пример заголовка\n\n"
    "Продолжение основного текста. Проверьте, нет ли искажённых символов.\n"
)

THAI = (
    "# เอกสารภาษาไทย\n\n"
    "ไฟล์นี้เขียนด้วยภาษาไทย เพื่อทดสอบการตรวจจับรหัสอักขระ "
    "เราได้เตรียมข้อความที่มีความยาวเพียงพอ ข้อความภาษาไทยประกอบด้วยพยัญชนะ "
    "สระ และวรรณยุกต์ หากตรวจสอบถูกต้อง ตัวอักษรเหล่านี้จะอ่านได้ตามปกติ\n\n"
    "## ตัวอย่างหัวข้อ\n\n"
    "เนื้อหายังคงดำเนินต่อไป ตรวจสอบว่าไม่มีตัวอักษรที่ผิดเพี้ยน\n"
)

CP1250 = (
    "# Dokument polski\n\n"
    "Ten plik został napisany w języku polskim. Aby sprawdzić wykrywanie "
    "kodowania, przygotowaliśmy tekst o odpowiedniej długości. Polski tekst "
    "zawiera znaki diakrytyczne, takie jak ą, ć, ę, ł, ń, ó, ś, ź oraz ż.\n\n"
    "## Przykład nagłówka\n\n"
    "Kontynuacja tekstu głównego. Sprawdź, czy nie ma uszkodzonych znaków.\n"
)

samples = {
    "sjis.txt": (SJIS, "shift_jis"),
    "euckr.txt": (EUCKR, "euc-kr"),
    "cp1251.txt": (CP1251, "cp1251"),
    "tis620.txt": (THAI, "tis-620"),
    "cp1250.txt": (CP1250, "cp1250"),
}
for name, (text, codec) in samples.items():
    data = text.encode(codec)
    (out / name).write_bytes(data)
    print(f"  {name}: codec={codec} bytes={len(data)}")
