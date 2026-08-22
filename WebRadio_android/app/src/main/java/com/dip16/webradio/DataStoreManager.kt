package com.dip16.webradio

import android.content.Context
import android.util.Log
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.dip16.webradio.ui.theme.Purple80
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore("data_store")

class DataStoreManager(private val context: Context) {

    suspend fun saveSetting(settingsData: SettingsData) {
        Log.i("dip17", "saveSetting: $settingsData")
        context.dataStore.edit { pref ->
            pref[intPreferencesKey("radio_mode")] = settingsData.radioMode
            pref[longPreferencesKey("bg_color")] = settingsData.bgColor
        }
        Log.i("dip17", "Save finished")
    }
/*
    fun getSettings() = context.dataStore.data.map { pref ->
        return@map SettingsData(
            pref[intPreferencesKey("radio_mode")] ?: 0,
            pref[longPreferencesKey("bg_color") ]?: Purple80.value.toLong()
        )
    }*/

    fun getSettings() = context.dataStore.data.map { pref ->
        val settingsData = SettingsData(
            pref[intPreferencesKey("radio_mode")] ?: 0,
            pref[longPreferencesKey("bg_color")] ?: Purple80.value.toLong()
        )
        Log.i("dip17", "getSettings: $settingsData")
        return@map settingsData
    }

    // Cached station list (JSON string received on Home/{radioName}/Stations)
    suspend fun saveStationsJson(json: String) {
        context.dataStore.edit { pref ->
            pref[stringPreferencesKey("stations_json")] = json
        }
    }

    fun getStationsJson(): Flow<String?> = context.dataStore.data.map { pref ->
        pref[stringPreferencesKey("stations_json")]
    }
}