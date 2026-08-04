package com.dolgate

import android.content.Context
import android.net.ConnectivityManager
import android.util.Log
import java.net.Inet6Address
import java.net.NetworkInterface
import mobile.AndroidNetworkProvider
import org.json.JSONArray
import org.json.JSONObject

/**
 * Tells the Go engine what the network looks like.
 *
 * Go cannot find this out for itself on Android: since SDK 30 SELinux denies apps the
 * NETLINK_ROUTE socket that `net.Interfaces()` binds, so tsnet fails to start with
 * "route ip+net: netlinkrib: permission denied" and no Tailnet ever comes up. Tailscale knows
 * about the restriction (tailscale#2293) and lets the app supply the facts instead — that is what
 * this class is for. Java's NetworkInterface takes a different route through the framework, so it
 * is still allowed to enumerate.
 *
 * Every call is a fresh look. Tailscale asks again whenever the link may have changed, so a cached
 * snapshot would keep it on a network the phone already left.
 */
class AndroidNetworkFacts(
  private val context: Context,
) : AndroidNetworkProvider {

  /**
   * The interface list as JSON, in the shape services/ssh-core/mobile/android_network.go parses.
   *
   * A single interface that refuses to answer must not cost us the whole list — some devices keep
   * entries that throw on getMTU/getIndex — so each one is read on its own and skipped when it
   * fails. Addresses carry their prefix length because that is how Tailscale decides whether two
   * addresses share a network.
   */
  override fun interfaces(): String {
    val interfaces = JSONArray()
    val enumeration =
      try {
        NetworkInterface.getNetworkInterfaces() ?: return interfaces.toString()
      } catch (error: Throwable) {
        Log.w(TAG, "could not enumerate network interfaces", error)
        return interfaces.toString()
      }

    for (candidate in enumeration) {
      val encoded =
        try {
          encode(candidate)
        } catch (error: Throwable) {
          Log.w(TAG, "skipping interface ${candidate.name}", error)
          continue
        }
      interfaces.put(encoded)
    }
    return interfaces.toString()
  }

  /**
   * The interface the default route currently uses, or "" when there is no network.
   *
   * Android's own defaultRoute() inside Tailscale returns only what it is told here, so leaving it
   * out means Tailscale never learns which link it is on.
   */
  override fun defaultRouteInterface(): String {
    val manager =
      context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return ""
    return try {
      val active = manager.activeNetwork ?: return ""
      manager.getLinkProperties(active)?.interfaceName ?: ""
    } catch (error: Throwable) {
      // Missing ACCESS_NETWORK_STATE, or the network vanished mid-call. Either way we do not know.
      Log.w(TAG, "could not read the default route interface", error)
      ""
    }
  }

  private fun encode(candidate: NetworkInterface): JSONObject {
    val addresses = JSONArray()
    for (address in candidate.interfaceAddresses) {
      val host = address.address ?: continue
      // IPv6 addresses arrive with a scope suffix ("fe80::1%wlan0") that is not part of the
      // address Go parses.
      val literal =
        if (host is Inet6Address) {
          host.hostAddress?.substringBefore('%')
        } else {
          host.hostAddress
        }
      if (literal.isNullOrEmpty()) {
        continue
      }
      addresses.put("$literal/${address.networkPrefixLength}")
    }

    return JSONObject().apply {
      put("name", candidate.name)
      put("index", candidate.index)
      put("mtu", candidate.mtu)
      put("up", candidate.isUp)
      put("loopback", candidate.isLoopback)
      put("pointToPoint", candidate.isPointToPoint)
      put("multicast", candidate.supportsMulticast())
      put("addrs", addresses)
    }
  }

  private companion object {
    const val TAG = "AndroidNetworkFacts"
  }
}
