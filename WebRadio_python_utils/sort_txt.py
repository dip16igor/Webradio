with open("bestlist.txt", "r") as file:
    lines = file.readlines()

lines = sorted(set(lines))

with open("bestlist_sorted.txt", "w") as file:
    for line in lines:
        file.write(line)
