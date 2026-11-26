"""Create the original, code-native diagrams used by the visual questions."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'static/media'
SVG = {
'v02': '<text x="320" y="235" text-anchor="middle" font-family="Georgia,serif" font-size="83" fill="#172239">MCMXLV</text>',
'v04': '<rect x="80" y="60" width="480" height="280" fill="white" stroke="#d5d9df"/><circle cx="320" cy="200" r="81" fill="#bc002d"/>',
'v06': '<rect x="80" y="60" width="480" height="93.34" fill="white"/><rect x="80" y="153.33" width="480" height="93.34" fill="#00966e"/><rect x="80" y="246.66" width="480" height="93.34" fill="#d62612"/><rect x="80" y="60" width="480" height="280" fill="none" stroke="#c9cdd5"/>',
'v08': '<circle cx="320" cy="200" r="128" fill="none" stroke="#9ca9bc" stroke-width="3"/><circle cx="320" cy="200" r="37" fill="#d84c50"/><path d="M304 200h32m-16-16v32" stroke="white" stroke-width="5"/><circle cx="448" cy="200" r="15" fill="#295bbd"/><path d="M440 200h16" stroke="white" stroke-width="3"/>',
'v10': '<rect x="35" y="50" width="570" height="300" fill="#477f65"/><g stroke="white" stroke-width="3" fill="none"><rect x="65" y="80" width="510" height="240"/><path d="M65 110h510M65 290h510M200 110v180M440 110v180M200 200h240"/><path d="M320 65v270" stroke="#172239" stroke-width="5"/></g>',
'v12': '<g transform="translate(115 80)"><rect x="0" y="93" width="410" height="200" rx="8" fill="#20252f"/><g stroke="#f5f5f5" stroke-width="2"><path d="M30 155h350M30 215h350M145 155v100M275 155v100"/></g><g transform="rotate(-17 0 95)"><rect x="0" y="50" width="410" height="45" fill="#20252f"/><g fill="white"><path d="M25 50h45l-25 45H0zM115 50h45l-25 45H90zM205 50h45l-25 45h-45zM295 50h45l-25 45h-45zM385 50h25v45h-50z"/></g></g></g>',
'v14': '<g stroke="#8993a3" stroke-width="2">'+''.join(f'<path d="M90 {y}h460"/>' for y in (120,155,190,225,260))+'</g><ellipse cx="305" cy="225" rx="28" ry="19" transform="rotate(-20 305 225)" fill="#172239"/><path d="M330 220V95" stroke="#172239" stroke-width="7"/>',
'v16': '<path d="M55 330Q170 300 305 330T590 330" fill="none" stroke="#acb6a3" stroke-width="4"/><path d="M240 325l28-180h103l29 180z" fill="#e4ceb2" stroke="#775f49" stroke-width="3"/><path d="M252 145l67-65 67 65z" fill="#75513e"/><rect x="301" y="270" width="39" height="55" rx="18" fill="#715e4b"/><g stroke="#715e4b" fill="#e6e9e8" stroke-width="4"><path d="M320 180L155 92l-17 33 182 55zM320 180l165 88 17-33-182-55zM320 180L408 15l33 17-121 148zM320 180l-88 165-33-17 121-148z"/></g><circle cx="320" cy="180" r="13" fill="#56483b"/>',
'v18': '<path d="M75 305h490" stroke="#b7a38d" stroke-width="8"/><ellipse cx="320" cy="309" rx="200" ry="18" fill="#e2d9ce"/><path d="M400 110h60l-9 55q60 100 0 130h-42q-58-30 0-130z" fill="#6b8d98"/><path d="M143 259q8-55 53-41 39-6 48 35t-48 46q-47 0-53-40" fill="#c95548"/><path d="M197 222l6-27" stroke="#6d5540" stroke-width="6"/><path d="M201 207q20-20 37-6-20 21-37 6" fill="#688944"/><ellipse cx="294" cy="267" rx="42" ry="32" fill="#dfaa47"/><path d="M289 239q-5-20 6-28" fill="none" stroke="#6d5540" stroke-width="5"/>',
'v20': '<rect x="135" y="95" width="370" height="210" rx="15" fill="#adb5c0" stroke="#4f5d70" stroke-width="6"/><rect x="157" y="116" width="326" height="168" rx="4" fill="#1d2531"/><rect x="178" y="204" width="284" height="61" rx="3" fill="#e7e9eb"/>'+''.join(f'<rect x="{x}" y="201" width="27" height="39" fill="#d4ae53"/>' for x in (202,263,324,385)),
'v22': '<g stroke="#384557" stroke-width="7" fill="none" stroke-linecap="round">'+''.join(f'<path d="M{300 if side<0 else 340} {y}l{side*70} {dy}l{side*25} {dy}"/>' for side in (-1,1) for y,dy in ((170,-28),(195,0),(220,28)))+'<path d="M305 126l-25-35m55 35 25-35"/></g><ellipse cx="320" cy="259" rx="46" ry="62" fill="#c08e42"/><ellipse cx="320" cy="190" rx="39" ry="55" fill="#705a43"/><circle cx="320" cy="124" r="33" fill="#b88e50"/><circle cx="307" cy="118" r="5" fill="#172239"/><circle cx="333" cy="118" r="5" fill="#172239"/>',
'v24': '<path d="M100 110l25 17 25-17 25 17 25-17 120 70 120-70 25 17 25-17 25 17 25-17v180l-25-17-25 17-25-17-25 17-120-70-120 70-25-17-25 17-25-17-25 17z" fill="#e6bd65" stroke="#a97c32" stroke-width="4"/><g fill="none" stroke="#bf903e" stroke-width="3"><path d="M150 145l153 48M150 255l153-48M490 145l-153 48M490 255l-153-48"/></g><path d="M313 180q-15 20 0 40h14q15-20 0-40z" fill="#c99a43"/>',
'v26': '<g fill="none" stroke="#315b85" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"><path d="M320 340V75M220 95v75q0 32 35 32h130q35 0 35-32V95"/></g><g fill="#315b85"><path d="M320 40l-23 48h46zM220 60l-23 48h46zM420 60l-23 48h46z"/></g>',
'v28': '<g fill="#e6e3d9" stroke="#8e8e83" stroke-width="3"><path d="M240 153h160l-13 180H253z"/><rect x="225" y="333" width="190" height="20"/><rect x="210" y="353" width="220" height="15"/><rect x="205" y="71" width="230" height="20"/><path d="M205 91h230v57H205z"/></g><g fill="none" stroke="#8e8e83" stroke-width="5"><path d="M260 120c0-37-64-37-64 0 0 29 49 29 49 0 0-16-29-16-29 0 0 8 12 8 12 0M380 120c0-37 64-37 64 0 0 29-49 29-49 0 0-16 29-16 29 0 0 8-12 8-12 0"/>'+''.join(f'<path d="M{x} 168l{(320-x)*0.15} 150"/>' for x in (268,294,320,346,372))+'</g>',
'v30': ''.join(f'<circle cx="{x}" cy="200" r="13" fill="#172239"/>' for x in (80,120,160,480,520,560))+''.join(f'<rect x="{x}" y="187" width="58" height="26" rx="8" fill="#172239"/>' for x in (218,291,364)),
}


def main():
    manifest_path = ROOT / 'credits.json'
    manifest = json.loads(manifest_path.read_text('utf-8'))
    for key, content in SVG.items():
        path = ROOT / (key + '.svg')
        path.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="white"/>'+content+'</svg>\n', encoding='utf-8')
        manifest[key] = dict(path='/media/'+path.name, credit='Куиз Загрявка', license='Авторска схема',
                             source_url='', license_url='', changes='',
                             sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    manifest['v03']['credit'] = 'NASA / екипажът на „Аполо 17“'
    manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('Original diagrams:', len(SVG), 'Total media:',len(manifest))


if __name__ == '__main__':
    main()
