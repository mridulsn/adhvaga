"""Adhvaga test runner.

Usage:
  .venv\\Scripts\\python run_tests.py            run all 100 cases, save results\\latest.json
  .venv\\Scripts\\python run_tests.py T02-01     run selected cases only (not saved)
"""
import sys

from adhvaga_harness.runner import main

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
