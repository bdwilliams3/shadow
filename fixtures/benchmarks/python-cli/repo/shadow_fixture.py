import argparse


def greeting(name: str = "world") -> str:
    return f"Hello, {name}."


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.parse_args()
    print(greeting())


if __name__ == "__main__":
    main()
