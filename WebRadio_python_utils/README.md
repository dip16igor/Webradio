# Python Utilities for WebRadio

This directory contains a collection of Python scripts for managing the radio station lists used by the WebRadio players.

## Scripts

### `webradio.py`

A command-line internet radio player that uses the `vlc` library. It can play stations from a `best.json` file.

**Usage:**

```bash
python webradio.py
```

The player will randomly select a station from the list and start playing. You can use the following commands:

- `P`: Play
- `S`: Stop
- `N`: Next station
- `A`: Add the current station to `bestlist.txt`

### `convert_txt_to_json.py`

This script reads a list of station URLs from a text file (`bestlist.txt`) and converts them into a JSON file (`best.json`) that can be used by the `webradio.py` player and other components of the project.

**Usage:**

```bash
python convert_txt_to_json.py
```

### `sort_txt.py`

This script reads the `bestlist.txt` file, removes any duplicate station URLs, sorts the list alphabetically, and saves the result to `bestlist_sorted.txt`.

**Usage:**

```bash
python sort_txt.py
```
