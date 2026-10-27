"""Builds a single-file copy of the site (scripts inlined, no html/head/body tags) for publishing as a Claude artifact."""
import pathlib, sys
root = pathlib.Path(__file__).parent
html = (root / 'index.html').read_text()
page = html.split('<!--PAGE-->', 1)[1].split('</body>', 1)[0]
page = page.replace('<!--/HEAD-->\n</head>\n<body>\n', '')
for name in ('parser.js', 'app.js'):
    page = page.replace(f'<script src="{name}"></script>', '<script>\n' + (root / name).read_text() + '\n</script>')
out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'dist' / 'pokemon-auction-tracker.html'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(page)
print(out)
