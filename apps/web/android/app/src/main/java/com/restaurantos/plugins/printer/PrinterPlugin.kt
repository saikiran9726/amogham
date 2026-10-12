package com.restaurantos.plugins.printer

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.UUID
import java.util.concurrent.Executors
import java.util.regex.Pattern

/**
 * Restaurant OS Custom Thermal Printer Plugin for Capacitor Android.
 * Provides direct byte stream access for Bluetooth RFCOMM (SPP), USB Host, and LAN raw TCP.
 * Hardened with:
 * - Thread pool for offloading socket I/O to background threads
 * - Host and port validation for LAN printing
 * - Strict socket timeouts
 * - Sanitized error messages (no raw stack traces / exception leaking to JS)
 */
@CapacitorPlugin(name = "PrinterPlugin")
class PrinterPlugin : Plugin() {

    companion object {
        // Standard Bluetooth Serial Port Profile (SPP) UUID
        private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        private const val DEFAULT_LAN_PORT = 9100
        private const val SOCKET_TIMEOUT_MS = 5000

        // Allow IPv4, alphanumeric hostname, and .local mDNS names
        private val HOST_PATTERN = Pattern.compile("^([a-zA-Z0-9.-]+)$")
    }

    private val executor = Executors.newCachedThreadPool()

    private var activeBtSocket: BluetoothSocket? = null
    private var activeTcpSocket: Socket? = null
    private var activeUsbConnection: UsbDeviceConnection? = null
    private var activeUsbEndpoint: UsbEndpoint? = null

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        executor.shutdownNow()
        closeAllConnections()
    }

    private fun closeAllConnections() {
        try { activeBtSocket?.close() } catch (_: Exception) {}
        activeBtSocket = null
        try { activeTcpSocket?.close() } catch (_: Exception) {}
        activeTcpSocket = null
        try { activeUsbConnection?.close() } catch (_: Exception) {}
        activeUsbConnection = null
        activeUsbEndpoint = null
    }

    /**
     * Validates and parses LAN host and port.
     */
    private fun parseLanAddress(address: String): Pair<String, Int>? {
        val parts = address.trim().split(":")
        val host = parts[0].trim()
        if (host.isEmpty() || !HOST_PATTERN.matcher(host).matches()) {
            return null
        }
        val port = if (parts.size > 1) {
            val p = parts[1].trim().toIntOrNull()
            if (p == null || p <= 0 || p > 65535) return null
            p
        } else {
            DEFAULT_LAN_PORT
        }
        return Pair(host, port)
    }

    /**
     * Discovers paired Bluetooth devices or attached USB printers.
     */
    @PluginMethod
    fun discover(call: PluginCall) {
        val transport = call.getString("transport") ?: "bluetooth"
        val devices = JSArray()

        executor.execute {
            try {
                when (transport) {
                    "bluetooth" -> {
                        val btAdapter = BluetoothAdapter.getDefaultAdapter()
                        if (btAdapter != null && btAdapter.isEnabled) {
                            val pairedDevices: Set<BluetoothDevice>? = btAdapter.bondedDevices
                            pairedDevices?.forEach { device ->
                                val obj = JSObject()
                                obj.put("name", device.name ?: "Unknown Bluetooth Printer")
                                obj.put("address", device.address)
                                obj.put("transport", "bluetooth")
                                devices.put(obj)
                            }
                        }
                    }
                    "usb" -> {
                        val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
                        usbManager.deviceList.values.forEach { device ->
                            val obj = JSObject()
                            obj.put("name", device.productName ?: "USB Thermal Printer")
                            obj.put("address", device.deviceName)
                            obj.put("vendorId", device.vendorId)
                            obj.put("productId", device.productId)
                            obj.put("transport", "usb")
                            devices.put(obj)
                        }
                    }
                    "lan" -> {
                        // LAN discovery via subnet scan / broadcast placeholder
                    }
                }
                val ret = JSObject()
                ret.put("devices", devices)
                call.resolve(ret)
            } catch (e: Exception) {
                call.reject("Device discovery failed")
            }
        }
    }

    /**
     * Connects to a printer via specified transport and address.
     */
    @PluginMethod
    fun connect(call: PluginCall) {
        val transport = call.getString("transport") ?: return call.reject("Transport is required")
        val address = call.getString("address") ?: return call.reject("Address is required")

        executor.execute {
            try {
                when (transport) {
                    "bluetooth" -> {
                        val btAdapter = BluetoothAdapter.getDefaultAdapter()
                            ?: return@execute call.reject("Bluetooth is unavailable on this device")
                        val device = btAdapter.getRemoteDevice(address)
                        activeBtSocket?.close()
                        val socket = device.createRfcommSocketToServiceRecord(SPP_UUID)
                        socket.connect()
                        activeBtSocket = socket
                        call.resolve(JSObject().put("connected", true))
                    }
                    "lan" -> {
                        val parsed = parseLanAddress(address)
                            ?: return@execute call.reject("Invalid printer host or port")
                        val (host, port) = parsed

                        activeTcpSocket?.close()
                        val socket = Socket()
                        socket.connect(InetSocketAddress(host, port), SOCKET_TIMEOUT_MS)
                        socket.soTimeout = SOCKET_TIMEOUT_MS
                        activeTcpSocket = socket
                        call.resolve(JSObject().put("connected", true))
                    }
                    "usb" -> {
                        val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
                        val device = usbManager.deviceList[address]
                            ?: return@execute call.reject("USB device not found")

                        var printerInterface: UsbInterface? = null
                        var endpointOut: UsbEndpoint? = null

                        for (i in 0 until device.interfaceCount) {
                            val iface = device.getInterface(i)
                            for (j in 0 until iface.endpointCount) {
                                val ep = iface.getEndpoint(j)
                                if (ep.direction == UsbConstants.USB_DIR_OUT) {
                                    printerInterface = iface
                                    endpointOut = ep
                                    break
                                }
                            }
                            if (endpointOut != null) break
                        }

                        if (printerInterface == null || endpointOut == null) {
                            return@execute call.reject("No writable endpoint found for USB device")
                        }

                        val connection = usbManager.openDevice(device)
                            ?: return@execute call.reject("Failed to open USB device or acquire permission")

                        connection.claimInterface(printerInterface, true)
                        activeUsbConnection = connection
                        activeUsbEndpoint = endpointOut
                        call.resolve(JSObject().put("connected", true))
                    }
                    else -> {
                        call.reject("Unsupported transport: $transport")
                    }
                }
            } catch (e: Exception) {
                call.reject("Connection to printer failed")
            }
        }
    }

    /**
     * Transmits raw ESC/POS byte sequence (encoded as Base64).
     */
    @PluginMethod
    fun write(call: PluginCall) {
        val transport = call.getString("transport") ?: return call.reject("Transport is required")
        val address = call.getString("address") ?: ""
        val dataBase64 = call.getString("data") ?: return call.reject("Data is required")
        val bytes = try {
            Base64.decode(dataBase64, Base64.DEFAULT)
        } catch (_: Exception) {
            return call.reject("Invalid Base64 payload")
        }

        executor.execute {
            try {
                when (transport) {
                    "bluetooth" -> {
                        val socket = activeBtSocket
                            ?: return@execute call.reject("Printer not connected over Bluetooth")
                        val outputStream: OutputStream = socket.outputStream
                        outputStream.write(bytes)
                        outputStream.flush()
                        call.resolve(JSObject().put("bytesWritten", bytes.size))
                    }
                    "lan" -> {
                        val socket = if (activeTcpSocket != null && activeTcpSocket!!.isConnected) {
                            activeTcpSocket!!
                        } else {
                            val parsed = parseLanAddress(address)
                                ?: return@execute call.reject("Invalid printer host or port")
                            val (host, port) = parsed
                            val s = Socket()
                            s.connect(InetSocketAddress(host, port), SOCKET_TIMEOUT_MS)
                            s.soTimeout = SOCKET_TIMEOUT_MS
                            s
                        }
                        val outputStream = socket.getOutputStream()
                        outputStream.write(bytes)
                        outputStream.flush()
                        call.resolve(JSObject().put("bytesWritten", bytes.size))
                    }
                    "usb" -> {
                        val conn = activeUsbConnection
                            ?: return@execute call.reject("Printer not connected over USB")
                        val ep = activeUsbEndpoint
                            ?: return@execute call.reject("USB endpoint not initialized")
                        val written = conn.bulkTransfer(ep, bytes, bytes.size, SOCKET_TIMEOUT_MS)
                        if (written < 0) {
                            call.reject("USB transmission failed")
                        } else {
                            call.resolve(JSObject().put("bytesWritten", written))
                        }
                    }
                    else -> {
                        call.reject("Unsupported transport: $transport")
                    }
                }
            } catch (e: Exception) {
                call.reject("Failed to transmit data to printer")
            }
        }
    }

    /**
     * Disconnects active socket or USB interface.
     */
    @PluginMethod
    fun disconnect(call: PluginCall) {
        executor.execute {
            try {
                closeAllConnections()
                call.resolve(JSObject().put("disconnected", true))
            } catch (e: Exception) {
                call.reject("Printer disconnect failed")
            }
        }
    }
}
