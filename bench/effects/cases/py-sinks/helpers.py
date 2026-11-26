import os


def cleanup(path):
    os.remove(path)


def level1(p):
    level2(p)


def level2(p):
    level3(p)


def level3(p):
    level4(p)


def level4(p):
    with open(p, "w") as f:
        f.write("deep")


OPS = {"wipe": os.remove}
