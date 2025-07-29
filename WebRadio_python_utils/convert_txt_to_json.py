import json

# Чтение ссылок из исходного файла
with open('bestlist.txt', 'r') as file:
    links = file.readlines()

# Создание списка словарей для JSON
data = []
for idx, link in enumerate(links):
    data.append({
        "name": f"Radio {idx}",
        "url": link.strip()
    })

# Запись данных в JSON файл
with open('best.json', 'w') as json_file:
    json.dump(data, json_file, ensure_ascii=False, indent=4)
