# Pokémon Auction Tracker

Tracks Pokémon auctions from Facebook groups and compares each live bid with what the card last sold for on eBay.

## Chrome extension (automatic)
The `extension/` folder is a Chrome extension. On your auction group in Facebook, each auction post gets a **+ Track this auction** button. For the posts you track it:
- reads the card, grade, every photo in the post, seller, reserve, postage, end time (in the post's time zone) and anti-snipe rule
- takes the highest dollar comment as the current bid and ignores "F" follows
- "Get eBay average" opens eBay AU sold listings for the card; the extension reads that page and saves the average of the last 10 sales (dropping the highest and lowest), then shows whether the bid is under, near or over market
- updates bids in the background (more often near the end), when you open the tracker, and when you press **↻ Update bids** on the post or **Update all** in the tracker. It never opens tabs; it only opens a post's "See more" and comments right after you press Track or Update.
- if a post has no buttons, right-click it and choose **Track this auction**

### Install
1. On GitHub press **Code → Download ZIP** and unzip it (or `git clone` the repo).
2. Go to `chrome://extensions`, turn on **Developer mode** (top right) and click **Load unpacked**.
3. Pick the `extension` folder inside it. Pin Pokémon Auction Tracker from the puzzle-piece menu.
4. Open your Facebook auction group and press **+ Track this auction** on the posts you want. Click the Pokémon Auction Tracker icon to see them.

Everything stays in your browser.

### Updating
Replace the folder's files with the new ones (or `git pull`), then press the ↻ reload arrow on the extension in `chrome://extensions` and refresh Facebook. The tracker shows its version at the top, so you can check the new one is running.

## Web page (paste-in)
`index.html` works without the extension: paste a post with its comments and it reads the same details. Auctions are saved in that browser.

## Development
- `parser.js` reads a post; `app.js` is the tracker page; `extension/ebay.js` reads eBay's sold listings.
- After editing `index.html`, `app.js` or `parser.js`, run `./make-extension.sh` to copy them into `extension/`.
- `build-artifact.py` makes a single-file copy for publishing as a Claude artifact.
