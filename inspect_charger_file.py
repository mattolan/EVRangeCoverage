import sys

filepath = r'C:\Users\Desktop\Downloads\Charger List Alberta.txt'
outpath = r'C:\code\EVRangeCoverage\charger_inspect_output.txt'

try:
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
except:
    with open(filepath, 'r', encoding='latin-1') as f:
        content = f.read()

with open(outpath, 'w', encoding='utf-8') as out:
    out.write(f'Total chars: {len(content)}\n')
    out.write(f'Total lines: {content.count(chr(10)) + 1}\n')
    out.write('\n=== FIRST 2000 chars ===\n')
    out.write(content[:2000])
    out.write('\n\n=== LAST 500 chars ===\n')
    out.write(content[-500:])
    out.write('\n\n=== MIDDLE 1000 chars ===\n')
    mid = len(content) // 2
    out.write(f'(offset {mid})\n')
    out.write(content[mid:mid+1000])
    out.write('\n')
