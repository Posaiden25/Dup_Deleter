# Dup_Deleter
A program that establishes a web UI to view photos on the local machine. Can view, sort and delete photos.
(Yes, unfortunately it doesn't delete duplicates on its own, although it did at one point, just terribly)

Photo Deduplicator & Management Tool (mainly a windows program)


The tool only reads/writes from a designated directory on disk.
You put your photos and media there yourself. The web UI is for browsing and deletion.

Features:
- Recursively scans the selected folder for all supported image types.
- Sorted oldest to newest.
- One photo at a time with left/right arrow key navigation.
- Delete only the photo you explicitly choose / are on (looking at).
- NO upload endpoint! All file i/o is strictly to the folder on disk.
      Or, if you're like me, you can access your server via mapping the drive

Required Libraries are: express, jimp, exifr, heic-convert

You are able to pass a folder as a arg:  node dupdeleter.js "C:\Users\SONY A7II"
Supported photo/file extensions: .jpg, .jpeg, .png, .heic, .heif, .raw, arw, .cr2, .nef, .orf, .sr2



To run this:
1. npm install express jimp exifr heic-convert
2. Run: node dupdeleter.js
   - A folder picker opens automatically (Windows), OR pass the path: node dupdeleter.js "C:\\Users\\SONY A7II"
     
3. Browse to http://localhost:3255
   
- Use ← → arrow keys to move between photos.
- Press ↓ to delete instantly.
