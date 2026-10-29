#!/usr/bin/env python3
"""CLI entry point forwarding to MainFrame."""

import sys
import os

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
from MainFrame import main

if __name__ == "__main__":
    main()
