package com.dip16.webradio

import android.annotation.SuppressLint
import android.content.Context
import android.media.MediaPlayer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.dip16.webradio.ui.theme.WebRadioTheme
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.eclipse.paho.client.mqttv3.MqttClient
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Done
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.Divider
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.TextField
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.DpOffset
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttException

import com.dip16.webradio.ui.theme.Purple80

//import androidx.datastore.preferences.preferencesDataStore


//private const val mqttBrokerUrl: String = "tcp://v.66p.su:1883"
private const val mqttBrokerUrl: String = "tcp://46.8.233.146:1883"
private const val mqttLogin: String = "dip16"
private const val mqttPassword: String = "nirvana7"
private var radioName = "WebRadio2" // 1 - Челябинск. 2 - Куса
private val alarms = listOf("5:00", "5:30", "6:00", "6:30", "7:00", "Alarm OFF")
//private val work_mode = listOf("Kusa", "Chel", "Online")
private val work_mode = listOf("Kusa", "Chel")

class MainActivity : ComponentActivity() {

    private lateinit var client: MqttClient

    private val station = mutableStateOf("")
    private val title = mutableStateOf("")
    private val state = mutableStateOf("")
    private val volume = mutableStateOf("")
    private val logText = mutableStateOf("")
    private val connectionState = mutableStateOf("")
    private val selectedIndex = mutableStateOf<Int?>(null) // Инициализация с null
    private val selectedIndex2 = mutableStateOf<Int?>(null) // Инициализация с null


    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dataStoreManager = DataStoreManager(this)
        Log.i("dip17", "onCreate(savedInstanceState)")
        setContent {
            WebRadioTheme {
                val bgColorState = remember { mutableStateOf(Purple80.value) }
                val radioMode = remember { mutableIntStateOf(0) }

                LaunchedEffect(key1 = true) {
                    Log.i("dip17", "Читаю настройки из памяти..")
                    //val dataStoreManager = DataStoreManager(applicationContext)
                    dataStoreManager.getSettings().collect { settings ->
                        bgColorState.value = settings.bgColor.toULong()
                        radioMode.intValue = settings.radioMode

                        selectedIndex2.value = radioMode.intValue
                    }
                }


                Log.i("dip17", "WebRadioTheme")
                // A surface container using the 'background' color from the theme
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    MQTTButtonsScreen(dataStoreManager, radioMode, buttonDataList)
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        Log.d("dip171", "onStart()")
        CoroutineScope(Dispatchers.IO).launch {
            // Подключение к MQTT и подписка на топик
            connectToMQTT()
        }
    }

    override fun onPause() {
        super.onPause()
        //disconnectFromMQTT()
        Log.d("dip171", "onPause()")
    }

    override fun onResume() {
        super.onResume()
        Log.d("dip171", "onResume()")
    }

    override fun onStop() {
        super.onStop()
        Log.d("dip171", "onStop()")
        // Отключение от MQTT
        disconnectFromMQTT()
    }

    @SuppressLint("DefaultLocale")
    fun convertSecondsToTime(seconds: Int): String {
        val hours = seconds / 3600
        val minutes = (seconds % 3600) / 60
        return "$hours:${String.format("%02d", minutes)}"
    }

    private fun connectToMQTT() {
        val persistence = MemoryPersistence()
        val mqttClientId = MqttClient.generateClientId()
        client = MqttClient(mqttBrokerUrl, mqttClientId, persistence)
        Log.d("dip17", "try to connect to MQTT broker")
        Log.d("dip17", "my ID is $mqttClientId")

        resetValues()

        try {
            val options = MqttConnectOptions().apply {
                userName = mqttLogin
                password = mqttPassword.toCharArray()
                isCleanSession = true
                isAutomaticReconnect = false // включаем автоматическое переподключение
                maxReconnectDelay = 2000
            }
            client.setCallback(object : MqttCallbackExtended {
                override fun connectComplete(reconnect: Boolean, serverURI: String) {
                    connectionState.value = "Connection OK"
                    Log.d("dip171", "connectComplete to $mqttBrokerUrl")
                    if (reconnect) subscribeToTopics()
                }

                override fun connectionLost(cause: Throwable?) {
                    connectionState.value = "Connection LOST.."
                    Log.e("dip171", "Connection lost to $mqttBrokerUrl  $cause")

                    connectToMQTT()
                }

                override fun messageArrived(topic: String?, message: MqttMessage?) {
                    Log.d("dip171", "Message received from $topic $message")
                }

                override fun deliveryComplete(token: IMqttDeliveryToken?) {
                    connectionState.value = "Request delivered"
                    Log.d("dip171", "deliveryComplete. Token : $token")

                    // Создаем Handler, привязанный к основному потоку
                    val handler = Handler(Looper.getMainLooper())

                    // Запускаем Runnable через 3 секунды
                    handler.postDelayed({
                        connectionState.value = ""
                        //Log.d("dip171", "connectionState cleared after 3 seconds")
                    }, 3000) // 3000 миллисекунд = 3 секунды
                }
            })

            connectionState.value = "Try to connect.."

            client.connect(options)

            if (client.isConnected) {
                Log.d("dip171", "connected!")
                connectionState.value = "Subscribe"
                subscribeToTopics()
                connectionState.value = "Send request"
                sendMessage("?")
            } else {
                Log.e("dip171", "Client not connected!")
                connectionState.value = "Client not connected!"
            }

        } catch (e: MqttException) {
            Log.e("dip171", "Fail connect to $mqttBrokerUrl !\n $e")
            e.printStackTrace()

            connectionState.value = "Connection Failed!"
        }
    }

    private fun resetValues() {
        station.value = " - - - "
        title.value = " - - - "
        state.value = " - - - "
        volume.value = "--"
        logText.value = " "
        selectedIndex.value = null
    }

    private fun subscribeToTopics() {
        val topics = listOf("State", "Log", "Station", "Title", "Volume", "Alarm")
        for (topic in topics) {
            client.subscribe("Home/$radioName/$topic") { _, msg ->
                handleMessage(topic, msg.toString())
            }
        }
    }

    private fun handleMessage(topic: String, message: String) {
        connectionState.value = " "
        when (topic) {
            "State" -> {
                state.value = message.ifEmpty { " " }
                Log.d("dip171", "State -> ${state.value}")
            }

            "Log" -> {
                logText.value = message.ifEmpty { " " }
                Log.d("dip171", "Log -> ${logText.value}")
            }

            "Station" -> {
                station.value = message.take(23)
                Log.d("dip171", "Station -> ${station.value}")
            }

            "Title" -> {
                title.value = message.ifEmpty { " " }
                Log.d("dip171", "Title -> ${title.value}")
            }

            "Volume" -> {
                volume.value = message.ifEmpty { " " }
                Log.d("dip171", "Volume -> ${volume.value}")
            }

            "Alarm" -> handleAlarm(message)
        }
    }

    private fun handleAlarm(newAlarm: String) {
        Log.d("dip17", "Alarm -> $newAlarm")
        if (newAlarm != "Alarm OFF") {
            val ssInt = newAlarm.toInt()
            val tt = convertSecondsToTime(ssInt)
            Log.d("dip17", tt)
            val idx = alarms.indexOf(tt)
            selectedIndex.value = if (idx != -1) idx else alarms.lastIndex
        } else {
            selectedIndex.value = alarms.lastIndex
            Log.d("dip17", "Alarm OFF!")
        }
    }

    private fun sendMessage(message: String) {
        val msg = MqttMessage(message.toByteArray())
        client.publish("Home/$radioName/Action", msg)
        Log.i("dip171", "request '$message' sent")
    }

    private fun disconnectFromMQTT() {
        try {
            if (client.isConnected) {
                client.disconnect()
                client.close()
                Log.d("dip171", "Disconnected from MQTT broker and client closed.")
            } else {
                Log.d("dip171", "Client is already disconnected.")
            }
        } catch (e: MqttException) {
            e.printStackTrace()
            Log.e("dip171", "Error while disconnecting: ${e.message}")
        }
    }

    data class ButtonData(val buttonText: String, val genre: String, val messageText: String)


    @Composable
    fun MQTTButtonsScreen(
        dataStoreManager: DataStoreManager,
        radioMode: MutableState<Int>,
        buttonDataList: List<ButtonData>
    ) {
        val displayMetrics = LocalContext.current.resources.displayMetrics
        val screenWidth = displayMetrics.xdpi
        val coroutineScope = rememberCoroutineScope()
        var expanded by remember { mutableStateOf(false) }
        var expanded2 by remember { mutableStateOf(false) }
        val context = LocalContext.current

        val cellsCount = 2 // Количество кнопок в строке
        val iconColor = getIconColor(selectedIndex.value)

        val coroutine = rememberCoroutineScope() // корутина для сохранения настроек в память

        //Log.i("dip17", "radioMode: ${radioMode.value}")

        Column(Modifier.padding(0.dp)) {

            Divider(color = Color.Gray, thickness = 1.dp)

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color.Gray),
                horizontalArrangement = Arrangement.spacedBy(1.dp)
            ) {
                TextFieldComponent(
                    value = station.value,
                    label = "Station: ${connectionState.value}",
                    enabled = false,
                    modifier = Modifier.weight(0.62f),
                    iconColor = iconColor
                )

                VolumeTextField(
                    value = "Vol: ${volume.value}",
                    modifier = Modifier.weight(0.38f),
                    label = state.value,
                    iconColor = iconColor,
                    onExpand = { expanded = true },
                )

                DropdownMenuComponent(
                    expanded = expanded,
                    onDismissRequest = { expanded = false },
                    screenWidth = screenWidth,
                    selectedIndex1 = selectedIndex.value,
                    alarms = alarms
                )

            }

            Box {
                TitleTextField(
                    value = title.value,
                    onExpand = { expanded2 = true }
                )
                DropdownMenuComponent2(
                    expanded = expanded2,
                    onDismissRequest = { expanded2 = false },
                    screenWidth = screenWidth,
                    //selectedIndex1 = selectedIndex2.value,
                    workMode = work_mode
                )
            }



            ButtonGrid(context)

            Divider(color = Color.Gray, thickness = 1.dp)

            LazyVerticalGrid(
                columns = GridCells.Fixed(cellsCount),
                contentPadding = PaddingValues(8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp)
            ) {
                items(buttonDataList.size) { index ->
                    MQTTButton(buttonDataList[index], index)
                }
            }
        }

        // Запуск LaunchedEffect для обработки изменений selectedIndex
        LaunchedEffect(selectedIndex.value) {
            handleSelectedIndexChange(selectedIndex.value, alarms, coroutineScope)
        }

        // Запуск LaunchedEffect для обработки изменений selectedIndex2
        LaunchedEffect(selectedIndex2.value) {
            handleSelectedIndexChange2(selectedIndex2.value, coroutineScope)
            saveSettings(selectedIndex2.value, dataStoreManager)
//            coroutine.launch{
//                selectedIndex2.value?.let { SettingsData(it, Purple80.value.toLong()) }?.let {
//                    dataStoreManager.saveSetting(
//                        it
//                    )
//                }
//            }
        }

    }

    private suspend fun saveSettings(selectedIndex: Int?, dataStoreManager: DataStoreManager) {
        Log.i("dip17", "Сохраняю настройки в память..")
        selectedIndex?.let {
            val settingsData = SettingsData(it, Purple80.value.toLong())
            dataStoreManager.saveSetting(settingsData)
        }

    }

    @Composable
    fun TextFieldComponent(
        value: String,
        label: String,
        enabled: Boolean,
        modifier: Modifier = Modifier,
        iconColor: Color
    ) {
        TextField(
            value = value,
            onValueChange = { /* no-op */ },
            label = { Text(label) },
            enabled = enabled,
            modifier = modifier,
            maxLines = 1,
            textStyle = TextStyle(
                fontSize = 16.sp,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.Bold
            ),
            shape = RoundedCornerShape(0.dp)
        )
    }

    @Composable
    fun VolumeTextField(
        value: String,
        label: String,
        modifier: Modifier = Modifier,
        iconColor: Color,
        onExpand: () -> Unit
    ) {
        TextField(
            value = value,
            onValueChange = { /* no-op */ },
            label = { Text(label) },
            trailingIcon = {
                IconButton(onClick = onExpand) {
                    Icon(Icons.Filled.Notifications, contentDescription = "Меню", tint = iconColor)
                }
            },
            enabled = false,
            modifier = modifier,
            //modifier = Modifier.weight(0.38f),
            //modifier = Modifier.fillMaxWidth().weight(0.38f),
            textStyle = TextStyle(
                fontSize = 16.sp,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.Bold
            ),
            shape = RoundedCornerShape(0.dp)
        )
    }

    @Composable
    fun DropdownMenuComponent(
        expanded: Boolean,
        onDismissRequest: () -> Unit,
        screenWidth: Float,
        selectedIndex1: Int?,
        alarms: List<String>
    ) {
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = onDismissRequest,
            offset = DpOffset(x = screenWidth.dp - 100.dp, y = 0.dp)
        ) {
            alarms.dropLast(1).forEachIndexed { index, item ->
                DropdownMenuItem(
                    onClick = {
                        selectedIndex.value = index
                        onDismissRequest()
                    },
                    text = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(item)
                            if (index == selectedIndex.value) {
                                Spacer(modifier = Modifier.width(8.dp))
                                Icon(Icons.Filled.Check, contentDescription = null)
                            }
                        }
                    },
                    modifier = Modifier.background(
                        if (index == selectedIndex.value) MaterialTheme.colorScheme.primary.copy(
                            alpha = 0.12f
                        ) else Color.Transparent
                    )
                )
            }
            DropdownMenuItem(
                onClick = {
                    selectedIndex.value = alarms.lastIndex
                    onDismissRequest()
                },
                text = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(alarms.last())
                        if (selectedIndex.value == alarms.lastIndex) {
                            Spacer(modifier = Modifier.width(8.dp))
                            Icon(Icons.Filled.Check, contentDescription = null)
                        }
                    }
                },
                modifier = Modifier.background(
                    if (selectedIndex.value == alarms.lastIndex) MaterialTheme.colorScheme.primary.copy(
                        alpha = 0.12f
                    ) else Color.Transparent
                )
            )
        }
    }

    @Composable
    fun DropdownMenuComponent2(
        expanded: Boolean,
        onDismissRequest: () -> Unit,
        screenWidth: Float,
        workMode: List<String>
    ) {
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = onDismissRequest,
            offset = DpOffset(x = screenWidth.dp - 100.dp, y = 0.dp)
        ) {
            workMode.forEachIndexed { index, item ->
                DropdownMenuItem(
                    onClick = {
                        selectedIndex2.value = index
                        onDismissRequest()
                    },
                    text = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(item)
                            if (index == selectedIndex2.value) {
                                Spacer(modifier = Modifier.width(8.dp))
                                Icon(Icons.Filled.Check, contentDescription = null)
                            }
                        }
                    },
                    modifier = Modifier.background(
                        if (index == selectedIndex2.value) MaterialTheme.colorScheme.primary.copy(
                            alpha = 0.12f
                        ) else Color.Transparent
                    )
                )
            }
        }
    }


    @Composable
    fun TitleTextField(
        value: String,
        onExpand: () -> Unit
    ) {
        TextField(
            value = value,
            onValueChange = { /* no-op */ },
            label = { Text(text = "Title:             ${logText.value}") },
            trailingIcon = {
                IconButton(onClick = onExpand) {
                    Icon(
                        Icons.Filled.MoreVert,
                        contentDescription = "Меню",
                        tint = MaterialTheme.colorScheme.primary
                    )
                }
            },
            enabled = false,
            modifier = Modifier.fillMaxWidth(),
            maxLines = 3,
            readOnly = true,
            textStyle = TextStyle(
                fontSize = 16.sp,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.Bold
            )
        )
    }

    @Composable
    fun ButtonGrid(context: Context) {
        Column(Modifier.padding(vertical = 4.dp, horizontal = 8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ButtonComponent(
                    "POWER",
                    "b1",
                    Modifier.weight(1f),
                    context,
                    Icons.Default.CheckCircle,
                    false
                ) {}
                ButtonComponent(
                    "CH +",
                    "b3",
                    Modifier.weight(1f),
                    context,
                    Icons.Default.Add,
                    false
                ) {}
                ButtonComponent(
                    "VOL +",
                    "vol+",
                    Modifier.weight(1f),
                    context,
                    Icons.Default.KeyboardArrowUp,
                    false
                ) {}
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ButtonComponent(
                    "SLEEP",
                    "b2",
                    Modifier.weight(1f),
                    context,
                    Icons.Default.Done,
                    false
                ) {}
                ButtonComponent(
                    "CH -",
                    "b4",
                    Modifier.weight(1f),
                    context,
                    Icons.Default.ArrowDropDown,
                    false
                ) {}
                ButtonComponent(
                    "VOL -",
                    "vol-",
                    Modifier.weight(1f),
                    context,
                    Icons.Default.KeyboardArrowDown,
                    false
                ) {}
            }
        }
    }

    private fun handleSelectedIndexChange(
        selectedIndex: Int?,
        alarms: List<String>,
        coroutineScope: CoroutineScope
    ) {
        if (selectedIndex != null) {
            coroutineScope.launch(Dispatchers.IO) {
                try {
                    val message = if (alarms[selectedIndex] != "Alarm OFF") {
                        val sec = convertTimeToSeconds(alarms[selectedIndex])
                        //MqttMessage("s$sec".toByteArray())
                        sendMessage("s$sec")
                    } else {
                        //MqttMessage("sAlarm OFF".toByteArray())
                        sendMessage("sAlarm OFF")
                    }
                    //client.publish("Home/$radioName/Action", message)
                } catch (e: MqttException) {
                    Log.e("MQTTError", "Ошибка связи с брокером: ${e.message}")
                }
            }
        }
    }

    private fun handleSelectedIndexChange2(
        selectedIndex: Int?,
        coroutineScope: CoroutineScope
    ) {
        if (selectedIndex != null) {


            coroutineScope.launch(Dispatchers.IO) {
                if (selectedIndex == 0) {
                    radioName = "WebRadio2"
                    Log.i("dip17", "radioName = $radioName")
                    connectToMQTT()
                }
                if (selectedIndex == 1) {
                    radioName = "WebRadio1"
                    Log.i("dip17", "radioName = $radioName")
                    connectToMQTT()
                }
//                try {
//                    sendMessage("?")
//                } catch (e: MqttException) {
//                    Log.e("dip17", "Ошибка связи с брокером: ${e.message}")
//                }
            }
        }
    }


    @Composable
    fun getIconColor(selectedIndex: Int?): Color {
        return when {
            selectedIndex == null -> MaterialTheme.colorScheme.background // Цвет по умолчанию
            selectedIndex != alarms.lastIndex -> MaterialTheme.colorScheme.primary // Цвет для выбранного индекса
            else -> Color.Gray // Цвет по умолчанию
        }
    }

    private fun convertTimeToSeconds(time: String): Int {
        val parts = time.split(":")
        val hours = parts[0].toInt()
        val minutes = parts[1].toInt()
        return hours * 3600 + minutes * 60
    }


    @Composable
    fun MQTTButton(
        buttonData: ButtonData,
        index: Int,
    ) {
        val context = LocalContext.current
        val coroutineScope = rememberCoroutineScope()
        val isPressed = remember { mutableStateOf(false) } // Состояние для отслеживания нажатия
        //
        val buttonColors = when (buttonData.genre) { // todo перенести цвета в тему
            "rock" -> ButtonDefaults.buttonColors(containerColor = Color(200, 50, 20))
            "jazz" -> ButtonDefaults.buttonColors(containerColor = Color(0, 100, 50))
            "radio" -> ButtonDefaults.buttonColors(containerColor = Color(0, 100, 200))
            "relax" -> ButtonDefaults.buttonColors(containerColor = Color(20, 100, 100))
            "ambient" -> ButtonDefaults.buttonColors(containerColor = Color(20, 20, 100))
            "lounge" -> ButtonDefaults.buttonColors(containerColor = Color(100, 0, 100))
            "electronic" -> ButtonDefaults.buttonColors(containerColor = Color(156, 39, 176, 255))
            "country" -> ButtonDefaults.buttonColors(containerColor = Color.LightGray)
            "reggae" -> ButtonDefaults.buttonColors(containerColor = Color.Gray)
            "nature" -> ButtonDefaults.buttonColors(containerColor = Color(0, 200, 150))
            else -> ButtonDefaults.buttonColors(
                containerColor = Color(
                    150,
                    150,
                    140
                )
            ) // Цвет по умолчанию
        }

        Button(
            onClick = {
                isPressed.value = true // Устанавливаем состояние нажатия
                CoroutineScope(Dispatchers.IO).launch {
                    val mediaPlayer = MediaPlayer.create(context, R.raw.button1)
                    // Установка громкости на 50% для обоих каналов
                    mediaPlayer.setVolume(0.2f, 0.2f)
                    mediaPlayer.start()
                }
                coroutineScope.launch(Dispatchers.IO) { // Запуск в фоновом потоке
                    try {
                        //Log.d("dip17", "MQTTButton click start")
                        if (state.value == "Power OFF") {
                            val message = MqttMessage("b1".toByteArray())
                            client.publish("Home/$radioName/Action", message)
                        }
                        station.value = " - - - "
                        title.value = " - - - "
                        logText.value = ""

                        //val message = MqttMessage(buttonData.messageText.toByteArray())
                        //client.publish("Home/$radioName/Action", message)
                        //Log.i("dip17", "Send ${buttonData.messageText} ..")
                        sendMessage(buttonData.messageText)


                        //Log.d("dip17", "MQTTButton click finish")
                    } catch (e: MqttException) {
                        // Обработка ошибки подключения или публикации
                        Log.e("dip17", "Ошибка связи с брокером: ${e.message}")
                        // Здесь можно добавить код для отображения уведомления пользователю
                    }
                }
            },
            modifier = Modifier
                //.longClickGestureFilter(onLongClick = { /* обработчик длительного нажатия */ })
                .fillMaxWidth(),
            //.background(if(isPressed.value)Color.Green.copy(alpha = 0.5f) else Color.Transparent),
            shape = RoundedCornerShape(8.dp),
            colors = buttonColors, // Использование определенного выше цвета кнопки
            contentPadding = PaddingValues(8.dp) // Установка внутренних отступов кнопки
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(0.dp),
                //        .background(if(isPressed.value)Color.Green.copy(alpha = 0.5f) else Color.Transparent),
                contentAlignment = Alignment.CenterStart
            ) {
                Text(
                    text = "${index + 1} ${buttonData.buttonText}",
                    style = TextStyle(
                        color = Color.White,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold // Установка жирного шрифта
                    )
                )
            }
        }
    }

    @Composable
    fun ButtonComponent(
        buttonText: String,
        message: String,
        modifier: Modifier,
        context: Context,
        icon: ImageVector,
        isIconVisible: Boolean = true,
        toggleIconVisibility: () -> Unit = {}
    ) {
        Button(
            onClick = {
                CoroutineScope(Dispatchers.IO).launch {
                    val mediaPlayer = MediaPlayer.create(context, R.raw.button1)
                    mediaPlayer.setVolume(0.5f, 0.5f)
                    mediaPlayer.start()
                }
                Log.d("dip17", "PRESS KEY!")
                if ((message == "b1") || (message == "b3") || (message == "b4")) {
                    //Log.d("dip17", "PRESS!")
                    station.value = " - - -"
                    title.value = " - - - "
                    logText.value = ""
                }

                Log.d("dip17", "Send message: $message")
                //sendMessage(message)
                val msg = MqttMessage(message.toByteArray())
                client.publish("Home/$radioName/Action", msg)

                toggleIconVisibility()
            }, modifier
        ) {
            Text(
                text = buttonText,
                style = TextStyle(
                    //color = Color.White,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold
                )
            )
            if (isIconVisible) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = Color.Green
                )
            }
        }
    }

    @Composable
    fun TextFieldComponent(topic: String, text: String = "") {

        TextField(
            value = text,
            onValueChange = { },
            label = { Text(topic) },
            enabled = false,
            modifier = Modifier
                .fillMaxWidth(),

            maxLines = 3,
            readOnly = true,
            textStyle = TextStyle(
                fontSize = 16.sp,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.Bold
            )
        )
    }
}
