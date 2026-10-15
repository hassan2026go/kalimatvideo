package com.nabdh.messenger

import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore

class MainActivity : AppCompatActivity() {
    private val auth by lazy { FirebaseAuth.getInstance() }
    private val db by lazy { FirebaseFirestore.getInstance() }
    private lateinit var root: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showAuthScreen()
    }

    private fun makeText(text: String, size: Float = 16f) = TextView(this).apply {
        this.text = text
        textSize = size
        gravity = Gravity.CENTER
        setPadding(16, 12, 16, 12)
    }

    private fun makeInput(hintText: String, isPassword: Boolean = false) = EditText(this).apply {
        hint = hintText
        textSize = 16f
        setSingleLine(true)
        if (isPassword) inputType = android.text.InputType.TYPE_CLASS_TEXT or
            android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
    }

    private fun baseScreen(title: String) {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(24, 28, 24, 24)
            setBackgroundColor(0xFFF6F8FA.toInt())
        }
        root.addView(makeText(title, 28f))
        setContentView(root)
    }

    private fun showAuthScreen() {
        baseScreen("نبض | Nabdh")
        root.addView(makeText("مسنجر تجريبي — تسجيل الدخول أو إنشاء حساب"))
        val email = makeInput("البريد الإلكتروني")
        email.inputType = android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
        val password = makeInput("كلمة المرور", true)
        root.addView(email)
        root.addView(password)
        val login = Button(this).apply { text = "تسجيل الدخول" }
        val register = Button(this).apply { text = "إنشاء حساب" }
        root.addView(login)
        root.addView(register)

        login.setOnClickListener {
            val e = email.text.toString().trim()
            val p = password.text.toString()
            if (e.isBlank() || p.length < 6) {
                toast("أدخل بريدًا صحيحًا وكلمة مرور من 6 أحرف على الأقل")
            } else auth.signInWithEmailAndPassword(e, p)
                .addOnSuccessListener { showChatScreen() }
                .addOnFailureListener { toast("تعذر تسجيل الدخول: ${it.localizedMessage ?: "تحقق من البيانات"}") }
        }
        register.setOnClickListener {
            val e = email.text.toString().trim()
            val p = password.text.toString()
            if (e.isBlank() || p.length < 6) {
                toast("أدخل بريدًا صحيحًا وكلمة مرور من 6 أحرف على الأقل")
            } else auth.createUserWithEmailAndPassword(e, p)
                .addOnSuccessListener {
                    val uid = auth.currentUser?.uid ?: return@addOnSuccessListener
                    db.collection("users").document(uid).set(
                        mapOf("uid" to uid, "email" to e, "createdAt" to com.google.firebase.firestore.FieldValue.serverTimestamp())
                    ).addOnSuccessListener { showChatScreen() }
                     .addOnFailureListener { toast("تم إنشاء الحساب لكن تعذر حفظ الملف الشخصي: ${it.localizedMessage}") }
                }
                .addOnFailureListener { toast("تعذر إنشاء الحساب: ${it.localizedMessage ?: "تحقق من الإعدادات"}") }
        }
    }

    private fun showChatScreen() {
        baseScreen("نبض | Nabdh")
        val user = auth.currentUser
        root.addView(makeText("أهلًا بك ${user?.email ?: ""}"))
        root.addView(makeText("هذه شاشة البداية. سنضيف قائمة المستخدمين والمحادثات بعد ضبط قواعد Firestore.", 16f))
        val logout = Button(this).apply { text = "تسجيل الخروج" }
        root.addView(logout)
        logout.setOnClickListener {
            auth.signOut()
            showAuthScreen()
        }
    }

    private fun toast(message: String) =
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
}
