import json
import random
import vlc
import threading

next_station = False

print("Start")
# # Открываем исходный файл для чтения
# with open('stream_list_1.json', 'r', encoding='utf-8') as file:
#     data = file.readlines()
# print("Convert file to json")
# # Преобразуем строки в корректный JSON формат
# json_data = []
# for line in data:
#     json_data.append(json.loads(line))

# # Записываем данные в новый файл в нужном формате
# with open('stream_list_2.json', 'w') as new_file:
#     json.dump(json_data, new_file, indent=4)

print("Load json to list")
# Загрузка списка потоков из файла stream_list.json
with open('best.json', 'r') as file:
    stream_list = json.load(file)


instance = vlc.Instance('--no-xlib')
player = instance.media_player_new()


# Функция для воспроизведения радио
def play_radio(station):
    print("")
    print("Playing:", station["name"])
    print("")
    print("URL:", station["url"])
    # Здесь можно реализовать воспроизведение радио
    # Запуск VLC без графического интерфейса
    # instance = vlc.Instance('--no-xlib')
    # player = instance.media_player_new()
    try:
        media = instance.media_new(station["url"])
        player.set_media(media)
        player.play()
    except Exception as e:
        print("Произошла ошибка:", e)


# Выбор случайного потока из списка
current_station = random.choice(stream_list)


def radio_control():
    global current_station
    global next_station
    # Цикл обработки ввода пользователя
    while True:
        user_input = input(
            "Enter command (P - Play, S - Stop, N - Next, A - Add to bestlist): ").upper()
        if player.get_state() == vlc.State.Ended:
            next_station = True
        if user_input == "P":
            play_radio(current_station)
        elif user_input == "S":
            player.stop()
            print("Stopped playback")
        elif user_input == "Q":
            print(f"Pleer: {player.get_state()}")
        elif user_input == "N" or next_station == True:
            next_station = False
            # Находим индекс элемента по его значению
            index_to_remove = next((index for (index, d) in enumerate(
                stream_list) if d["name"] == current_station["name"]), None)

            # Удаляем элемент из списка
            if index_to_remove is not None:
                del stream_list[index_to_remove]
                print("Станция", current_station["name"], "удалена из списка.")
                print(f"Длина списка ситанций: {len(stream_list)}")
            else:
                print(
                    "Станция", current_station["name"], "не найдена в списке.")

            current_station = random.choice(stream_list)
            play_radio(current_station)
            # print("Switched to new station")
        elif user_input == "A":
            with open('bestlist.txt', 'a') as file:
                file.write(current_station["url"] + '\n')
            print("Added current station to bestlist.txt")
        else:
            print("Invalid command. Please enter P, S, N, or +")


def main():
    while True:
        global next_station
        global current_station
        if player.get_state() == vlc.State.Ended:
            next_station = False
            # Находим индекс элемента по его значению
            index_to_remove = next((index for (index, d) in enumerate(
                stream_list) if d["name"] == current_station["name"]), None)

            # Удаляем элемент из списка
            if index_to_remove is not None:
                del stream_list[index_to_remove]
                print("Станция", current_station["name"], "удалена из списка.")
                print(f"Длина списка ситанций: {len(stream_list)}")
            else:
                print(
                    "Станция", current_station["name"], "не найдена в списке.")

            current_station = random.choice(stream_list)
            play_radio(current_station)
            print("Switched to new station")


radio_thread = threading.Thread(target=radio_control)
radio_thread.start()

main_thread = threading.Thread(target=main)
main_thread.start()
